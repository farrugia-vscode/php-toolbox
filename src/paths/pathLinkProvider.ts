import * as vscode from 'vscode';
import { pathLiterals, resolveAgainstFile } from './pathLiterals';

async function isFile(uri: vscode.Uri): Promise<boolean> {
  try {
    return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File;
  } catch {
    return false;
  }
}

/**
 * Turns the string literals that name an existing file into ctrl+clickable links:
 * `require __DIR__ . '/web/auth.php'` navigates, and so does any other string that
 * happens to resolve — nothing is linked unless the file is really there, so no
 * guessing about which calls take a path.
 */
export class PathLinkProvider implements vscode.DocumentLinkProvider {
  async provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentLink[]> {
    const file = document.uri.fsPath;
    const links: vscode.DocumentLink[] = [];
    // The same path is often written several times in a file (one per require).
    const targets = new Map<string, boolean>();

    for (const literal of pathLiterals(document.getText())) {
      if (token.isCancellationRequested) {
        return links;
      }

      const target = resolveAgainstFile(file, literal.value);
      const uri = vscode.Uri.file(target);
      const isExisting = targets.get(target) ?? (await isFile(uri));
      targets.set(target, isExisting);

      if (!isExisting) {
        continue;
      }

      links.push(
        new vscode.DocumentLink(
          new vscode.Range(document.positionAt(literal.start), document.positionAt(literal.end)),
          uri,
        ),
      );
    }

    return links;
  }
}
