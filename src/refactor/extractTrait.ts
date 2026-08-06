import * as vscode from 'vscode';
import type { Declaration } from '../php/parser';
import { indexedFile, type IndexedFile } from '../php/phpIndex';
import { directoryForNamespace } from '../php/psr4';
import { askName } from './apply';
import { classAt } from './classEdits';
import { EditSet } from './editSet';
import { importEdit, typesUsedIn } from './imports';
import { phpFileContents } from './newFile';
import { blankLineBefore, indentAt, indentUnit, memberSpan, reindent } from './textLayout';

/** A member of the class, with the docblock and the lines that belong to it. */
interface MovableMember {
  kind: 'method' | 'property' | 'constant';
  name: string;
  label: string;
  start: number;
  end: number;
}

/**
 * Everything the class declares itself, in the order it was written.
 *
 * A promoted constructor parameter is a property, but it cannot leave the constructor it is
 * written in, so it is not offered.
 */
function movableMembers(file: IndexedFile, declaration: Declaration): MovableMember[] {
  const { parsed, text } = file;
  const isOwned = (className: string, start: number): boolean =>
    className === declaration.fqn && start >= declaration.bodyStart && start <= declaration.bodyEnd;
  const methods = parsed.methods.filter((method) => isOwned(method.className, method.start));

  const found: MovableMember[] = [
    ...parsed.constants
      .filter((constant) => isOwned(constant.className, constant.start))
      .map((constant) => ({
        kind: 'constant' as const,
        name: constant.name,
        label: constant.name,
        start: constant.start,
        end: constant.end,
      })),
    ...parsed.properties
      .filter(
        (property) =>
          isOwned(property.className, property.start) &&
          !methods.some((method) => property.start > method.start && property.start < method.end),
      )
      .map((property) => ({
        kind: 'property' as const,
        name: property.name,
        label: `$${property.name}`,
        start: property.start,
        end: property.end,
      })),
    ...methods.map((method) => ({
      kind: 'method' as const,
      name: method.name,
      label: `${method.name}()`,
      start: method.start,
      end: method.end,
    })),
  ];

  return found
    .sort((first, second) => first.start - second.start)
    .map((member) => ({ ...member, ...memberSpan(text, member.start, member.end) }));
}

/** Where `use TheTrait;` goes: the first line of the body, above everything else. */
function useTraitEdit(declaration: Declaration, name: string, indent: string): {
  start: number;
  end: number;
  text: string;
} {
  return {
    start: declaration.bodyStart,
    end: declaration.bodyStart,
    text: `\n${indent}use ${name};\n`,
  };
}

/**
 * Moves the chosen members of a class into a new trait next to it, and uses that trait from
 * the class.
 *
 * The members are moved, not copied: a trait exists to hold the only copy of what it
 * carries, and a class keeping its own would silently win over it.
 */
export async function extractTrait(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const declaration = classAt(file.parsed, editor.document.offsetAt(editor.selection.active));

  if (!declaration || (declaration.kind !== 'class' && declaration.kind !== 'trait')) {
    vscode.window.showWarningMessage('Place the cursor inside a class or a trait.');
    return;
  }

  const members = movableMembers(file, declaration);

  if (members.length === 0) {
    vscode.window.showWarningMessage(`${declaration.name} has no member to move.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    members.map((member) => ({ label: member.label, description: member.kind, member })),
    { title: `Members of ${declaration.name} to move into a trait`, canPickMany: true },
  );

  if (!picked || picked.length === 0) {
    return;
  }

  const name = await askName('Extract trait', `${declaration.name}Trait`);

  if (!name) {
    return;
  }

  const directory = await directoryForNamespace(file.parsed.namespace);

  if (!directory) {
    vscode.window.showErrorMessage(`No composer psr-4 root matches ${file.parsed.namespace}.`);
    return;
  }

  const unit = indentUnit(file.text);
  const moved = picked.map((item) => item.member);
  // Every member span starts at the beginning of its line, so this is the body indentation.
  const sourceIndent = indentAt(file.text, moved[0].start);
  const body = moved
    .map((member) => reindent(file.text.slice(member.start, member.end).trimEnd(), sourceIndent, unit))
    .join('\n\n');
  const types = moved.flatMap((member) => typesUsedIn(file, member));
  const imports = importEdit({ ...file.parsed, imports: [], importAnchor: 0 }, types);

  const target = vscode.Uri.joinPath(directory, `${name}.php`);
  const edit = new vscode.WorkspaceEdit();

  edit.createFile(target, { ignoreIfExists: false });
  edit.insert(
    target,
    new vscode.Position(0, 0),
    phpFileContents({ namespace: file.parsed.namespace, imports: imports?.text ?? '', header: `trait ${name}`, body }),
  );

  const removals = new EditSet();

  moved.forEach((member) =>
    removals.add({ start: blankLineBefore(file.text, member.start), end: member.end, text: '' }),
  );
  removals.add(useTraitEdit(declaration, name, sourceIndent));

  removals.all().forEach((textEdit) => {
    edit.replace(file.uri, file.mapper.range(textEdit.start, textEdit.end), textEdit.text);
  });

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  vscode.window.showInformationMessage(`${name} — ${moved.length} member(s) moved.`);
}
