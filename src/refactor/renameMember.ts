import * as vscode from 'vscode';
import { getPhpIndex, indexedFile, type IndexedFile } from '../php/phpIndex';
import { shortNameOf } from '../php/fqn';
import { askName, withProgress } from './apply';
import {
  findMemberSites,
  memberFamily,
  methodAtCursor,
  projectOf,
  receiverFqn,
  type MemberRef,
  type MemberSite,
} from './callSites';
import { reportUnresolved } from './unresolved';
import { EditSet } from './editSet';

/** The member the cursor is on, with the class that declares it. */
export interface MemberTarget extends MemberRef {
  file: IndexedFile;
}

/**
 * Declarations of the same member across the family: overrides, interface, trait.
 *
 * Renaming the method of an interface renames the contract, so every class bound by it has
 * to be renamed in the same edit — including the ones the class being renamed never names.
 */
async function declarations(target: MemberTarget): Promise<Array<{ file: IndexedFile; nameStart: number; nameEnd: number }>> {
  const project = await projectOf();
  const files = project.files;
  const family = memberFamily(project, target);

  return files.flatMap((file) => {
    const members =
      target.kind === 'method'
        ? file.parsed.methods
        : target.kind === 'constant'
          ? file.parsed.constants
          : file.parsed.properties;

    return members
      .filter((member) => member.name === target.name && family.has(member.className))
      .map((member) => ({ file, nameStart: member.nameStart, nameEnd: member.nameEnd }));
  });
}

/** A property declared in the constructor signature is renamed there too. */
function promotedParam(file: IndexedFile, target: MemberTarget): { nameStart: number; nameEnd: number } | null {
  if (target.kind !== 'property') {
    return null;
  }

  const constructor = file.parsed.methods.find(
    (method) => method.className === target.className && method.name === '__construct',
  );
  const param = constructor?.params.find((candidate) => candidate.isPromoted && candidate.name === target.name);

  if (!param) {
    return null;
  }

  const written = file.text.indexOf(`$${target.name}`, param.start);

  return written === -1 ? null : { nameStart: written + 1, nameEnd: written + 1 + target.name.length };
}

/** The declaring class of what the cursor points at, whether a declaration or a mention. */
export async function memberAtCursor(file: IndexedFile, offset: number): Promise<MemberTarget | null> {
  // `nameStart` sits after the `$`, but a cursor placed just before the name is on it: that
  // is where a click before `$prices` lands, and missing it hands the rename to another branch.
  const property = file.parsed.properties.find(
    (candidate) =>
      offset >= candidate.nameStart - (file.text[candidate.nameStart - 1] === '$' ? 1 : 0) &&
      offset <= candidate.nameEnd,
  );

  if (property) {
    return { kind: property.isStatic ? 'staticProperty' : 'property', name: property.name, className: property.className, file };
  }

  const constant = file.parsed.constants.find((candidate) => offset >= candidate.nameStart && offset <= candidate.nameEnd);

  if (constant) {
    return { kind: 'constant', name: constant.name, className: constant.className, file };
  }

  const method = await methodAtCursor(file, offset);

  if (method) {
    return { kind: 'method', name: method.method.name, className: method.method.className, file };
  }

  const access = file.parsed.accesses.find((candidate) => offset >= candidate.nameStart && offset <= candidate.nameEnd);

  if (!access) {
    return null;
  }

  const owner = await declaringClass(file, access, offset);

  return owner ? { kind: access.kind, name: access.name, className: owner, file } : null;
}

/** Which class declares the member an access reads, following the receiver as written. */
async function declaringClass(
  file: IndexedFile,
  access: { name: string; kind: string; receiverKind: string; receiverText: string; nameStart: number },
  offset: number,
): Promise<string | null> {
  const files = await getPhpIndex();
  const holders = files.flatMap((candidate) =>
    (access.kind === 'constant' ? candidate.parsed.constants : candidate.parsed.properties)
      .filter((member) => member.name === access.name)
      .map((member) => member.className),
  );

  if (access.receiverKind === 'type' || access.receiverKind === 'parent') {
    const reference = file.parsed.references.find(
      (candidate) => candidate.end <= access.nameStart && access.nameStart - candidate.end <= 4,
    );

    return reference?.fqn ?? null;
  }

  const declared = await receiverFqn(file, access.receiverText, offset);

  if (declared) {
    return declared;
  }

  const enclosing = file.parsed.declarations.find(
    (declaration) => declaration.bodyStart <= offset && declaration.bodyEnd >= offset,
  );

  // `$this->total` inside a class that declares it, or the one class in the project that does.
  if (enclosing && holders.includes(enclosing.fqn)) {
    return enclosing.fqn;
  }

  return holders.length === 1 ? holders[0] : null;
}

/** Everything a member rename touches, ready to be shown before it is applied. */
export interface MemberRename {
  edit: vscode.WorkspaceEdit;
  count: number;
  files: number;
  /** Mentions of the name the rename did not touch, because nothing attributed them. */
  unresolved: MemberSite[];
}

/**
 * Every edit renaming a member takes: its declarations, the overrides that have to follow,
 * and each mention the project makes of it.
 */
export async function buildMemberRename(target: MemberTarget, newName: string): Promise<MemberRename> {
  const { sites, unresolved, arguments: promotedArguments } = await findMemberSites(target);
  const byFile = new Map<IndexedFile, EditSet>();
  const add = (host: IndexedFile, nameStart: number, nameEnd: number): void => {
    const edits = byFile.get(host) ?? new EditSet();
    edits.add({ start: nameStart, end: nameEnd, text: newName });
    byFile.set(host, edits);
  };

  (await declarations(target)).forEach((declaration) => add(declaration.file, declaration.nameStart, declaration.nameEnd));
  sites.forEach((site) => add(site.file, site.nameStart, site.nameEnd));

  // `new Order(total: 10)` names the promoted parameter, so the label follows the rename.
  // A positional argument names nothing and is left exactly as it is.
  promotedArguments
    .filter((argument) => argument.labelStart !== null)
    .forEach((argument) => add(argument.file, argument.labelStart!, argument.labelEnd!));

  const promoted = promotedParam(target.file, target);

  if (promoted) {
    add(target.file, promoted.nameStart, promoted.nameEnd);
  }

  const edit = new vscode.WorkspaceEdit();
  let count = 0;

  byFile.forEach((edits, host) => {
    edits.all().forEach((textEdit) => {
      count++;
      edit.replace(host.uri, host.mapper.range(textEdit.start, textEdit.end), textEdit.text);
    });
  });

  return { edit, count, files: byFile.size, unresolved };
}

/**
 * Renames a method, a property or a class constant everywhere the project mentions it.
 *
 * A mention is rewritten because its receiver was proven to hold the class — through a
 * typed parameter, a typed property, an assignment or a chain of declared return types —
 * never because the name matches. Sharing a name with `Builder::exists()` is not a reason
 * to edit a query someone else wrote.
 */
export async function renameMember(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const target = await memberAtCursor(file, editor.document.offsetAt(editor.selection.active));

  if (!target) {
    vscode.window.showWarningMessage('Place the cursor on a method, a property or a class constant.');
    return;
  }

  const kindLabel = target.kind === 'method' ? 'method' : target.kind === 'constant' ? 'constant' : 'property';
  const newName = await askName(
    `Rename ${shortNameOf(target.className)}::${target.name}`,
    target.name,
    `Renames the ${kindLabel} and every mention of it`,
  );

  if (!newName || newName === target.name) {
    return;
  }

  const rename = await withProgress(`Renaming ${target.name}…`, () => buildMemberRename(target, newName));

  await vscode.workspace.applyEdit(rename.edit, { isRefactoring: true });
  vscode.window.showInformationMessage(
    `Renamed to ${newName} — ${rename.count} edits across ${rename.files} file(s).`,
  );

  await reportUnresolved(target.name, rename.unresolved);
}
