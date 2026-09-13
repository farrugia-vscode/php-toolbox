import * as vscode from 'vscode';
import { packageLinks } from './packageLinks';

/** The composer.json of an installed package, null when the package is not there. */
async function readManifest(folder: vscode.Uri, packagePath: string[]): Promise<unknown | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, ...packagePath));

    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Not installed, or a manifest composer itself could not read: either way there is no
    // installed copy to link, and the name still leads to the repository or to Packagist.
    return null;
  }
}

/**
 * Makes the packages of a composer.json ctrl+clickable: the name goes to the code on
 * GitHub, or to Packagist; the version constraint goes to the copy under `vendor/`.
 */
export class ComposerPackageLinkProvider implements vscode.DocumentLinkProvider {
  async provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentLink[]> {
    const folder = vscode.Uri.joinPath(document.uri, '..');
    const links = await packageLinks(document.getText(), (packagePath) => readManifest(folder, packagePath));

    if (token.isCancellationRequested) {
      return [];
    }

    return links.map((link) => {
      const target = 'url' in link.target ? vscode.Uri.parse(link.target.url) : vscode.Uri.joinPath(folder, ...link.target.packagePath);
      const documentLink = new vscode.DocumentLink(new vscode.Range(document.positionAt(link.start), document.positionAt(link.end)), target);
      documentLink.tooltip = link.tooltip;

      return documentLink;
    });
  }
}
