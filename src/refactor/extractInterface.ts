import * as vscode from 'vscode';
import type { MethodDeclaration } from '../php/members';
import { indexedFile, type IndexedFile } from '../php/phpIndex';
import { directoryForNamespace } from '../php/psr4';
import { askName } from './apply';
import { classAt } from './classEdits';
import { importEdit, typesUsedIn } from './imports';
import { indentUnit } from './textLayout';

/** Methods worth publishing: the constructor and the magic ones are not part of a contract. */
function publishable(file: IndexedFile, className: string): MethodDeclaration[] {
  return file.parsed.methods.filter(
    (method) =>
      method.className === className &&
      method.visibility === 'public' &&
      !method.name.startsWith('__') &&
      !method.isAbstract,
  );
}

/** The signature as written, without the modifiers an interface refuses. */
function signatureOf(file: IndexedFile, method: MethodDeclaration): string {
  const end = method.bodyStart === null ? method.end : file.text.lastIndexOf('{', method.bodyStart);
  const written = file.text.slice(method.start, end).trim();

  return `${written.replace(/\b(final|abstract)\s+/g, '').replace(/\s+/g, ' ')};`;
}

function fileContents(namespace: string, name: string, signatures: string[], imports: string, unit: string): string {
  return [
    '<?php',
    '',
    `namespace ${namespace};`,
    '',
    imports,
    `interface ${name}`,
    '{',
    signatures.map((signature) => `${unit}${signature}`).join('\n\n'),
    '}',
    '',
  ]
    .filter((line, index) => line !== '' || index !== 4 || imports !== '')
    .join('\n');
}

/** Adds the interface to what the class already implements. */
function implementsEdit(file: IndexedFile, bodyStart: number, isFirst: boolean, name: string): { start: number; end: number; text: string } {
  const header = file.text.slice(0, bodyStart - 1);
  const anchor = header.trimEnd().length;

  return { start: anchor, end: anchor, text: isFirst ? ` implements ${name}` : `, ${name}` };
}

/**
 * Publishes the public API of a class as an interface, and makes the class implement it.
 *
 * The interface lands next to the class in the same namespace, which is where the psr-4
 * autoloader expects it and where anyone reading the class will look for it.
 */
export async function extractInterface(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const declaration = classAt(file.parsed, editor.document.offsetAt(editor.selection.active));

  if (!declaration || declaration.kind !== 'class') {
    vscode.window.showWarningMessage('Place the cursor inside a class.');
    return;
  }

  const methods = publishable(file, declaration.fqn);

  if (methods.length === 0) {
    vscode.window.showWarningMessage(`${declaration.name} has no public method to publish.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    methods.map((method) => ({ label: method.name, description: signatureOf(file, method), picked: true, method })),
    { title: `Methods of ${declaration.name} to publish`, canPickMany: true },
  );

  if (!picked || picked.length === 0) {
    return;
  }

  const name = await askName('Extract interface', `${declaration.name}Interface`);

  if (!name) {
    return;
  }

  const directory = await directoryForNamespace(file.parsed.namespace);

  if (!directory) {
    vscode.window.showErrorMessage(`No composer psr-4 root matches ${file.parsed.namespace}.`);
    return;
  }

  const types = picked.flatMap((item) =>
    typesUsedIn(file, { start: item.method.start, end: item.method.bodyStart ?? item.method.end }),
  );
  const imports = importEdit({ ...file.parsed, imports: [], importAnchor: 0, namespace: file.parsed.namespace }, types);
  const contents = fileContents(
    file.parsed.namespace,
    name,
    picked.map((item) => signatureOf(file, item.method)),
    imports?.text ?? '',
    indentUnit(file.text),
  );

  const target = vscode.Uri.joinPath(directory, `${name}.php`);
  const edit = new vscode.WorkspaceEdit();

  edit.createFile(target, { ignoreIfExists: false });
  edit.insert(target, new vscode.Position(0, 0), contents);

  const change = implementsEdit(file, declaration.bodyStart, declaration.interfaces.length === 0, name);
  edit.replace(file.uri, file.mapper.range(change.start, change.end), change.text);

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  vscode.window.showInformationMessage(`${name} — ${picked.length} method(s) published.`);
}
