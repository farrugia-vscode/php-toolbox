import * as vscode from 'vscode';
import { directoryOf, typedPath } from './pathLiterals';

const RETRIGGER: vscode.Command = {
  command: 'editor.action.triggerSuggest',
  title: 'Suggest',
};

function toCompletionItem(
  name: string,
  fileType: vscode.FileType,
  range: vscode.Range,
): vscode.CompletionItem {
  const isDirectory = fileType === vscode.FileType.Directory;
  const item = new vscode.CompletionItem(
    name,
    isDirectory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
  );

  item.range = range;
  // Directories sort first: they are a step towards the file being typed, never the target.
  item.sortText = `${isDirectory ? '0' : '1'}${name}`;

  if (isDirectory) {
    item.insertText = `${name}/`;
    item.command = RETRIGGER;
  }

  return item;
}

/**
 * Completes file names inside string literals, relative to the file being edited:
 * `require __DIR__ . '/web/` offers what sits in that directory. Only strings that
 * already hold a separator are completed, so route names and config keys are left alone.
 */
export class PathCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const typed = typedPath(document.lineAt(position.line).text.slice(0, position.character));

    if (!typed) {
      return undefined;
    }

    const directory = vscode.Uri.file(directoryOf(document.uri.fsPath, typed.prefix));
    let entries: [string, vscode.FileType][];

    try {
      entries = await vscode.workspace.fs.readDirectory(directory);
    } catch {
      return undefined;
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    const range = new vscode.Range(position.translate(0, -typed.segmentLength), position);

    return entries
      .filter(([name]) => !name.startsWith('.'))
      .map(([name, fileType]) => toCompletionItem(name, fileType, range));
  }
}
