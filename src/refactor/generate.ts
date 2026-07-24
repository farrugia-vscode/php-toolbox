import * as vscode from 'vscode';
import type { MethodDeclaration } from '../php/members';
import type { Declaration } from '../php/parser';
import { getPhpIndex, indexedFile, type IndexedFile } from '../php/phpIndex';
import { withProgress } from './apply';
import { classAt, memberIndent, memberInsertOffset } from './classEdits';
import { EditSet } from './editSet';
import { importEdit, typesUsedIn } from './imports';
import { indentUnit } from './textLayout';

interface OwnedMethod {
  file: IndexedFile;
  method: MethodDeclaration;
}

/** Every type the class inherits from, interfaces of interfaces included. */
function ancestorsOf(declaration: Declaration, all: Declaration[]): Declaration[] {
  const seen = new Map<string, Declaration>();
  const queue = [...declaration.interfaces, declaration.parent ?? '', ...declaration.traits].filter(Boolean);

  while (queue.length > 0) {
    const fqn = queue.shift()!;

    if (seen.has(fqn)) {
      continue;
    }

    const found = all.find((candidate) => candidate.fqn === fqn);

    if (found) {
      seen.set(fqn, found);
      queue.push(...found.interfaces, found.parent ?? '', ...found.traits);
    }
  }

  return [...seen.values()];
}

/** Methods the class has to declare and does not: interface methods and abstract ones. */
async function missingMethods(declaration: Declaration): Promise<OwnedMethod[]> {
  const files = await getPhpIndex();
  const all = files.flatMap((candidate) => candidate.parsed.declarations);
  const ancestors = ancestorsOf(declaration, all);
  const methodsOf = (fqn: string): OwnedMethod[] =>
    files.flatMap((candidate) =>
      candidate.parsed.methods
        .filter((method) => method.className === fqn)
        .map((method) => ({ file: candidate, method })),
    );

  const provided = new Set<string>(
    [declaration.fqn, ...ancestors.filter((ancestor) => ancestor.kind !== 'interface').map((ancestor) => ancestor.fqn)]
      .flatMap(methodsOf)
      .filter(({ method }) => !method.isAbstract)
      .map(({ method }) => method.name.toLowerCase()),
  );

  const required = ancestors
    .filter((ancestor) => ancestor.kind === 'interface' || ancestor.isAbstract)
    .flatMap((ancestor) => methodsOf(ancestor.fqn))
    .filter(({ method }) => method.isAbstract || method.className.length > 0);

  const wanted = new Map<string, OwnedMethod>();

  required
    .filter(({ method }) => !provided.has(method.name.toLowerCase()))
    .forEach((owned) => wanted.set(owned.method.name.toLowerCase(), owned));

  return [...wanted.values()];
}

/** The signature as written in the interface, ready to take a body. */
function stubOf(owned: OwnedMethod, indent: string, unit: string): string {
  const { file, method } = owned;
  const end = method.bodyStart === null ? method.end : file.text.lastIndexOf('{', method.bodyStart);
  const signature = file.text
    .slice(method.start, end)
    .trim()
    .replace(/\babstract\s+/g, '')
    .replace(/;$/, '')
    .replace(/\s+/g, ' ');

  return [`${indent}${signature}`, `${indent}{`, `${indent}${unit}// TODO: implement ${method.name}()`, `${indent}}`].join('\n');
}

/**
 * Writes the methods an interface or an abstract parent asks for, with their signatures
 * copied as they were declared — including the types, which is the part nobody enjoys
 * retyping.
 */
export async function implementMissing(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const declaration = classAt(file.parsed, editor.document.offsetAt(editor.selection.active));

  if (!declaration) {
    vscode.window.showWarningMessage('Place the cursor inside a class.');
    return;
  }

  const missing = await withProgress('Reading the contracts of the class…', () => missingMethods(declaration));

  if (missing.length === 0) {
    vscode.window.showInformationMessage(`${declaration.name} implements everything it has to.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    missing.map((owned) => ({
      label: owned.method.name,
      description: owned.method.className.split('\\').pop(),
      picked: true,
      owned,
    })),
    { title: `Methods to implement in ${declaration.name}`, canPickMany: true },
  );

  if (!picked || picked.length === 0) {
    return;
  }

  const unit = indentUnit(file.text);
  const indent = memberIndent(file.text, file.parsed, declaration);
  const anchor = memberInsertOffset(file.text, file.parsed, declaration, 'method');
  const edits = new EditSet();
  const body = picked.map((item) => stubOf(item.owned, indent, unit)).join('\n\n');

  edits.add({
    start: anchor.offset,
    end: anchor.offset,
    text: anchor.isFirstInBody ? `\n${body}\n` : `\n\n${body}`,
  });

  const types = picked.flatMap((item) =>
    typesUsedIn(item.owned.file, {
      start: item.owned.method.start,
      end: item.owned.method.bodyStart ?? item.owned.method.end,
    }),
  );
  const imports = importEdit(file.parsed, types);

  if (imports) {
    edits.add(imports);
  }

  const edit = new vscode.WorkspaceEdit();
  edits.all().forEach((textEdit) => {
    edit.replace(file.uri, file.mapper.range(textEdit.start, textEdit.end), textEdit.text);
  });

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(`${picked.length} method(s) implemented.`);
}

/**
 * Writes a constructor that takes the chosen properties and assigns them.
 *
 * Properties already declared keep their declaration: promoting them is a separate step,
 * offered on the parameter itself.
 */
export async function generateConstructor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const declaration = classAt(file.parsed, editor.document.offsetAt(editor.selection.active));

  if (!declaration) {
    vscode.window.showWarningMessage('Place the cursor inside a class.');
    return;
  }

  if (file.parsed.methods.some((method) => method.className === declaration.fqn && method.name === '__construct')) {
    vscode.window.showWarningMessage(`${declaration.name} already has a constructor.`);
    return;
  }

  const properties = file.parsed.properties.filter(
    (property) => property.className === declaration.fqn && !property.isStatic,
  );

  if (properties.length === 0) {
    vscode.window.showWarningMessage(`${declaration.name} has no property to fill.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    properties.map((property) => ({
      label: `$${property.name}`,
      description: property.type ?? '',
      picked: true,
      property,
    })),
    { title: `Properties ${declaration.name} takes at construction`, canPickMany: true },
  );

  if (!picked || picked.length === 0) {
    return;
  }

  const unit = indentUnit(file.text);
  const indent = memberIndent(file.text, file.parsed, declaration);
  const params = picked
    .map((item) => `${item.property.type ? `${item.property.type} ` : ''}$${item.property.name}`)
    .join(', ');
  const body = picked.map((item) => `${indent}${unit}$this->${item.property.name} = $${item.property.name};`).join('\n');
  const constructor = [`${indent}public function __construct(${params})`, `${indent}{`, body, `${indent}}`].join('\n');

  // The constructor belongs above the methods, right after the properties it fills.
  const firstMethod = file.parsed.methods.find((method) => method.className === declaration.fqn);
  const anchor = firstMethod
    ? { offset: firstMethod.start, isFirstInBody: false }
    : memberInsertOffset(file.text, file.parsed, declaration, 'method');

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    file.uri,
    file.mapper.range(anchor.offset, anchor.offset),
    firstMethod ? `${constructor.trimStart()}\n\n${indent}` : anchor.isFirstInBody ? `\n${constructor}\n` : `\n\n${constructor}`,
  );

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(`Constructor with ${picked.length} parameter(s) written.`);
}
