import * as vscode from 'vscode';
import { ancestorsOf } from '../php/hierarchy';
import type { MemberAccess, MethodCall } from '../php/members';
import { astOf } from '../php/nodeIndex';
import type { Declaration } from '../php/parser';
import { findDeclaration, getPhpIndex, indexedFile, type IndexedFile } from '../php/phpIndex';
import { directoryForNamespace } from '../php/psr4';
import { scopesOf } from '../php/scopeCache';
import { scopeAt } from '../php/scopes';
import { receiverFqn } from './callSites';
import { classAt, memberIndent, memberInsertOffset } from './classEdits';
import { draftText, inferParams, type MemberDraft } from './createMember';
import { unresolvedTypeAt } from './importSymbol';
import { phpFileContents } from './newFile';
import { indentUnit } from './textLayout';

/** The class a missing member has to be written into. */
interface Destination {
  file: IndexedFile;
  declaration: Declaration;
  /** Reached through `$this`, so the member can be private and stay where it is used. */
  isSelf: boolean;
}

const KEYWORD_RECEIVERS = new Set(['this', 'self', 'static']);

/** The type name written right before the `::` of a static call. */
function staticReceiverFqn(file: IndexedFile, nameStart: number): string | null {
  const reference = file.parsed.references.find(
    (candidate) => candidate.end <= nameStart && nameStart - candidate.end <= 2,
  );

  return reference?.fqn ?? null;
}

/** Where a call or an access points, when the file says enough to know. */
async function destinationOf(
  file: IndexedFile,
  mention: { receiverKind: string; receiverText: string; nameStart: number },
  offset: number,
): Promise<Destination | null> {
  if (KEYWORD_RECEIVERS.has(mention.receiverKind)) {
    const enclosing = classAt(file.parsed, offset);

    return enclosing ? { file, declaration: enclosing, isSelf: true } : null;
  }

  const fqn =
    mention.receiverKind === 'type' || mention.receiverKind === 'parent'
      ? staticReceiverFqn(file, mention.nameStart)
      : await receiverFqn(file, mention.receiverText, mention.nameStart);

  if (!fqn) {
    return null;
  }

  const found = await findDeclaration(fqn);

  return found ? { file: found.file, declaration: found.declaration, isSelf: false } : null;
}

/** Names the class and everything it inherits already declare, for the given kind. */
async function knownNames(declaration: Declaration, kind: 'method' | 'property'): Promise<Set<string>> {
  const files = await getPhpIndex();
  const family = [declaration, ...ancestorsOf(declaration, files.flatMap((file) => file.parsed.declarations))];
  const owners = new Set(family.map((member) => member.fqn));
  const declared = files.flatMap((file): { name: string; className: string }[] =>
    kind === 'method' ? file.parsed.methods : file.parsed.properties,
  );

  return new Set(
    declared
      .filter((member) => owners.has(member.className))
      .map((member) => member.name.toLowerCase()),
  );
}

/** The edit that writes the member into its class. */
function insertEdit(destination: Destination, draft: MemberDraft): { start: number; end: number; text: string } {
  const { file, declaration } = destination;
  const indent = memberIndent(file.text, file.parsed, declaration);
  const anchor = memberInsertOffset(file.text, file.parsed, declaration, draft.kind);
  const code = draftText(draft, indent, indentUnit(file.text));

  return {
    start: anchor.offset,
    end: anchor.offset,
    text: anchor.isFirstInBody ? `\n${code}\n` : anchor.isAfterOtherKind ? `\n\n${code}` : `\n${code}`,
  };
}

function actionFor(destination: Destination, draft: MemberDraft): vscode.CodeAction {
  const written = draft.kind === 'method' ? `${draft.name}()` : `$${draft.name}`;
  const where = destination.isSelf ? '' : ` in ${destination.declaration.name}`;
  const action = new vscode.CodeAction(`Create ${draft.kind} ${written}${where}`, vscode.CodeActionKind.QuickFix);
  const edit = insertEdit(destination, draft);

  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(destination.file.uri, destination.file.mapper.range(edit.start, edit.end), edit.text);

  return action;
}

/** The call under the cursor, when its name is not declared anywhere it could be. */
async function missingMethodAction(
  file: IndexedFile,
  offset: number,
): Promise<vscode.CodeAction[]> {
  const call = file.parsed.calls.find(
    (candidate) => offset >= candidate.nameStart && offset <= candidate.nameEnd,
  );

  if (!call) {
    return [];
  }

  const destination = await destinationOf(file, call, offset);

  if (!destination || (await knownNames(destination.declaration, 'method')).has(call.name.toLowerCase())) {
    return [];
  }

  const scope = scopeAt(scopesOf(file), offset, offset);
  const enclosing = classAt(file.parsed, offset);
  const draft: MemberDraft = {
    kind: 'method',
    name: call.name,
    params: inferParams(
      argumentNodes(file, call),
      file.text,
      file.parsed,
      scope?.params ?? [],
      enclosing?.fqn ?? '',
    ),
    isSignatureOnly: destination.declaration.kind === 'interface',
    visibility: destination.isSelf ? 'private' : 'public',
    type: null,
  };

  return [actionFor(destination, draft)];
}

/**
 * The argument nodes of the call, read back from the tree.
 *
 * The parsed file keeps the offsets of each argument but not the nodes themselves, and the
 * types are read off the nodes.
 */
function argumentNodes(file: IndexedFile, call: MethodCall): any[] {
  const found: any[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.kind === 'call' && node.loc?.start.offset === call.start && node.loc?.end.offset === call.end) {
      found.push(...(node.arguments ?? []));
      return;
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(astOf(file.text));

  return found;
}

/** A `$this->something` that names no property the class has. */
async function missingPropertyAction(file: IndexedFile, offset: number): Promise<vscode.CodeAction[]> {
  const access = file.parsed.accesses.find(
    (candidate) => offset >= candidate.nameStart && offset <= candidate.nameEnd,
  );

  // Only through `$this`: elsewhere, adding a property to someone else's class is a guess.
  if (!access || access.kind !== 'property' || access.receiverKind !== 'this') {
    return [];
  }

  const destination = await destinationOf(file, access, offset);

  if (!destination || (await knownNames(destination.declaration, 'property')).has(access.name.toLowerCase())) {
    return [];
  }

  return [
    actionFor(destination, {
      kind: 'property',
      name: access.name,
      params: [],
      isSignatureOnly: false,
      visibility: 'private',
      type: assignedType(file, access),
    }),
  ];
}

/** The type the property would hold, when the line assigns something that says so. */
function assignedType(file: IndexedFile, access: MemberAccess): string | null {
  const scope = scopeAt(scopesOf(file), access.nameStart, access.nameStart);
  const enclosing = classAt(file.parsed, access.nameStart);
  const assigned = assignedValue(astOf(file.text), access.nameStart);

  if (!assigned) {
    return null;
  }

  return (
    inferParams([assigned], file.text, file.parsed, scope?.params ?? [], enclosing?.fqn ?? '')[0]?.type ?? null
  );
}

/** The right-hand side of the assignment the access is the target of, if it is one. */
function assignedValue(ast: any, nameStart: number): any | null {
  let found: any = null;

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object' || found) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    const isTarget =
      node.kind === 'assign' &&
      node.operator === '=' &&
      node.left?.offset?.loc?.start.offset === nameStart;

    if (isTarget) {
      found = node.right;
      return;
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

  return found;
}

/** A type nothing in the project declares, offered as a file to create. */
async function missingTypeActions(file: IndexedFile, offset: number): Promise<vscode.CodeAction[]> {
  const declared = new Set(file.parsed.declarations.map((declaration) => declaration.fqn));
  const unresolved = unresolvedTypeAt(file, offset, declared);

  if (!unresolved) {
    return [];
  }

  const index = await getPhpIndex();
  const isKnown = index.some((candidate) =>
    candidate.parsed.declarations.some((entry) => entry.name === unresolved.shortName),
  );

  // A name that exists elsewhere wants an import, which is another provider's answer.
  if (isKnown) {
    return [];
  }

  const namespace = file.parsed.namespace;
  const directory = await directoryForNamespace(namespace);

  if (!directory) {
    return [];
  }

  return (['class', 'interface'] as const).map((kind) => {
    const action = new vscode.CodeAction(
      `Create ${kind} ${unresolved.shortName} in ${namespace}`,
      vscode.CodeActionKind.QuickFix,
    );
    const target = vscode.Uri.joinPath(directory, `${unresolved.shortName}.php`);

    action.edit = new vscode.WorkspaceEdit();
    action.edit.createFile(target, { ignoreIfExists: true });
    action.edit.insert(
      target,
      new vscode.Position(0, 0),
      phpFileContents({
        namespace,
        imports: '',
        header: `${kind === 'class' ? 'final class' : 'interface'} ${unresolved.shortName}`,
        body: '',
      }),
    );

    return action;
  });
}

/**
 * Offers to write what a line uses and nothing declares: the method a call names, the
 * property `$this` reads, the class a name points at.
 *
 * Nothing is offered unless the destination is certain. A call on a variable of unknown type
 * could reach anything, and writing a method into the wrong class is worse than not offering.
 */
export class CreateFromUsageCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    _context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeAction[]> {
    const file = indexedFile(document.uri, document.getText());
    const offset = document.offsetAt(range.start);

    const actions = [
      ...(await missingMethodAction(file, offset)),
      ...(await missingPropertyAction(file, offset)),
      ...(await missingTypeActions(file, offset)),
    ];

    return token.isCancellationRequested ? [] : actions;
  }
}
