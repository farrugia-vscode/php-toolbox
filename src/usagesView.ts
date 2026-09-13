import * as vscode from 'vscode';
import { prepareListing } from './usagesListing';
import type { FromWebviewMessage, PreparedListing, ToWebviewMessage } from './usagesProtocol';

export { plural } from './usagesListing';

const VIEW_ID = 'phpToolbox.usages';
const HAS_LISTING_CONTEXT = 'phpToolbox.usages.hasListing';

/** One place in the project, as a line of the listing. */
export interface UsageEntry {
  uri: vscode.Uri;
  range: vscode.Range;
  /** What the line reads as: the code itself, or the name of the class found there. */
  label: string;
  description?: string;
}

/** Entries put under one heading, by what the code does with the symbol. */
export interface UsageGroup {
  label: string;
  entries: UsageEntry[];
}

/** What a search answers: the symbol asked about, and its usages sorted by intent. */
export interface UsageListing {
  subject: string;
  /** How the entries are counted in the heading: "references", "usages", "implementations". */
  unit: string;
  groups: UsageGroup[];
}

function nonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/** The page the panel loads once; every listing is then posted to it. */
function shell(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'usages.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'usages.css'));
  const scriptNonce = nonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Usages</title>
</head>
<body>
  <main id="usages"></main>
  <script nonce="${scriptNonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * The panel behind the listing: a webview drawing what `prepareListing` hands it, and
 * opening the file a line stands for when the webview asks.
 *
 * Kept alive while hidden, so switching panels and back does not redraw the listing. The
 * page says when it is up, since a message posted while it still loads is lost.
 */
class UsagesViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private listing: PreparedListing | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = shell(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((message: FromWebviewMessage) => this.receive(message));
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  show(listing: PreparedListing): void {
    this.listing = listing;

    if (this.view) {
      this.view.description = `${listing.subject}: ${listing.count}`;
      this.post({ type: 'listing', listing });
    }
  }

  private post(message: ToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async receive(message: FromWebviewMessage): Promise<void> {
    if (message.type === 'ready') {
      if (this.listing) {
        this.post({ type: 'listing', listing: this.listing });
      }

      return;
    }

    const { place } = message;

    await vscode.window.showTextDocument(vscode.Uri.parse(message.uri), {
      selection: new vscode.Range(place.line, place.character, place.endLine, place.endCharacter),
      viewColumn: message.isBeside ? vscode.ViewColumn.Beside : undefined,
      preserveFocus: !message.shouldFocusEditor,
      preview: !message.shouldFocusEditor,
    });
  }
}

let provider: UsagesViewProvider | null = null;

export function registerUsagesView(extensionUri: vscode.Uri): vscode.Disposable {
  provider = new UsagesViewProvider(extensionUri);

  return vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } });
}

/**
 * The line a usage sits on, so the panel can colour it and mark the usage in it. A file
 * gone since the search leaves its lines plain: the entry still opens it, and the editor
 * reports the missing file itself.
 */
async function readLine(uri: vscode.Uri, line: number): Promise<string | null> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);

    return line < document.lineCount ? document.lineAt(line).text : null;
  } catch {
    return null;
  }
}

/**
 * Puts a listing in the panel and brings the panel up.
 *
 * A quick pick shows one flat column where a heading is a thin grey line; the panel keeps
 * every heading and every file, coloured and foldable, which is what a long listing needs
 * to be read rather than scrolled.
 */
export async function showUsagesView(listing: UsageListing): Promise<void> {
  if (!provider) {
    throw new Error('The usages view is shown before it is registered.');
  }

  provider.show(await prepareListing(listing, (uri) => vscode.workspace.asRelativePath(uri), readLine));

  await vscode.commands.executeCommand('setContext', HAS_LISTING_CONTEXT, true);
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}
