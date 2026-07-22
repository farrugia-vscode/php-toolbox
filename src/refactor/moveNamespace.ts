import * as vscode from 'vscode';
import { indexedFile } from '../php/phpIndex';
import { directoryForNamespace, namespaceForFile } from '../php/psr4';
import { buildTypeRename, namespaceOf, shortNameOf } from './renameType';

const FQN = /^[A-Za-z_]\w*(\\[A-Za-z_]\w*)+$/;

async function readText(uri: vscode.Uri): Promise<string | null> {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString(),
  );

  if (open) {
    return open.getText();
  }

  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return null;
  }
}

/** The single type a file declares, when the file is named after it. */
async function soleType(uri: vscode.Uri): Promise<string | null> {
  if (!uri.path.endsWith('.php')) {
    return null;
  }

  const text = await readText(uri);

  if (text === null) {
    return null;
  }

  const { parsed } = indexedFile(uri, text);
  const basename = (uri.path.split('/').pop() ?? '').replace(/\.php$/, '');
  const declaration = parsed.declarations.find((candidate) => candidate.name === basename);

  return parsed.declarations.length === 1 && declaration ? declaration.fqn : null;
}

/**
 * Keeps the namespace and every reference in step when a file is moved or renamed from
 * the explorer — the drag and drop people expect to just work.
 */
export function registerFileMoveSync(): vscode.Disposable {
  return vscode.workspace.onWillRenameFiles((event) => {
    event.waitUntil(
      (async () => {
        const edit = new vscode.WorkspaceEdit();

        for (const { oldUri, newUri } of event.files) {
          const oldFqn = await soleType(oldUri);
          const newNamespace = await namespaceForFile(newUri);

          if (!oldFqn || newNamespace === null) {
            continue;
          }

          const newName = (newUri.path.split('/').pop() ?? '').replace(/\.php$/, '');
          const newFqn = newNamespace ? `${newNamespace}\\${newName}` : newName;

          if (newFqn === oldFqn) {
            continue;
          }

          // The editor performs the move itself, so the edits stay on the old location.
          const rename = await buildTypeRename(oldFqn, newFqn, { moveFile: false });
          rename.edit.entries().forEach(([uri, edits]) => {
            edits.forEach((textEdit) => edit.replace(uri, textEdit.range, textEdit.newText));
          });
        }

        return edit;
      })(),
    );
  });
}

/**
 * Edits the fully qualified name as one string, so the namespace, the class name or both
 * change in a single step — which is how a class usually moves: it gets a new home and a
 * better name at the same time.
 */
export async function moveClass(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const fqn = await soleType(editor.document.uri);

  if (!fqn) {
    vscode.window.showInformationMessage('This file must declare a single type named after it.');
    return;
  }

  const target = await vscode.window.showInputBox({
    title: 'Move class',
    prompt: 'Edit the namespace, the class name, or both.',
    value: fqn,
    // The class name comes preselected: renaming in place is the most common of the two.
    valueSelection: [fqn.length - shortNameOf(fqn).length, fqn.length],
    validateInput: (value) => (FQN.test(value.trim()) ? null : 'Invalid fully qualified name.'),
  });

  if (target === undefined || target.trim() === fqn) {
    return;
  }

  const newFqn = target.trim();

  if (!(await directoryForNamespace(namespaceOf(newFqn)))) {
    vscode.window.showErrorMessage(`No composer psr-4 root matches ${namespaceOf(newFqn)}.`);
    return;
  }

  const { edit, manual, referenceCount } = await buildTypeRename(fqn, newFqn);
  await vscode.workspace.applyEdit(edit, { isRefactoring: true });

  if (manual.length > 0) {
    vscode.window.showWarningMessage(
      `Grouped imports left untouched in: ${manual.map((uri) => uri.path.split('/').pop()).join(', ')}`,
    );
  }

  vscode.window.showInformationMessage(`${shortNameOf(newFqn)} — ${referenceCount} edits.`);
}
