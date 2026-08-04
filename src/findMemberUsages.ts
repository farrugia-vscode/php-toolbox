import * as vscode from 'vscode';
import { findMemberSites, type MemberSite } from './refactor/callSites';
import { indexedFile } from './php/phpIndex';
import { memberAtCursor, type MemberTarget } from './refactor/renameMember';

interface SiteQuickPickItem extends vscode.QuickPickItem {
  site?: MemberSite;
}

/** The line a mention sits on, trimmed: enough to recognise the call without opening it. */
function lineAt(site: MemberSite): string {
  const start = site.file.text.lastIndexOf('\n', site.nameStart) + 1;
  const end = site.file.text.indexOf('\n', site.nameEnd);

  return site.file.text.slice(start, end === -1 ? undefined : end).trim();
}

function toItems(sites: MemberSite[]): SiteQuickPickItem[] {
  const certain = sites.filter((site) => site.isCertain);
  const doubtful = sites.filter((site) => !site.isCertain);

  const group = (label: string, group: MemberSite[]): SiteQuickPickItem[] =>
    group.length === 0
      ? []
      : [
          { label, kind: vscode.QuickPickItemKind.Separator },
          ...group.map((site) => ({
            label: lineAt(site),
            description: vscode.workspace.asRelativePath(site.file.uri),
            site,
          })),
        ];

  return [
    ...group(`certain (${certain.length})`, certain),
    // A receiver whose type is unknown may or may not be this member: shown apart rather
    // than dropped, since dropping a real call is worse than showing one too many.
    ...group(`unsure of the receiver (${doubtful.length})`, doubtful),
  ];
}

async function reveal(site: MemberSite): Promise<void> {
  const document = await vscode.workspace.openTextDocument(site.file.uri);
  const editor = await vscode.window.showTextDocument(document);
  const position = document.positionAt(site.nameStart);

  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

/** What to call the thing being searched, in the progress message and the picker. */
function labelOf(target: MemberTarget): string {
  const kind = target.kind === 'method' ? '' : target.kind === 'constant' ? '::' : '->';

  return `${target.className.split('\\').pop()}${kind === '' ? '::' : kind}${target.name}${target.kind === 'method' ? '()' : ''}`;
}

/**
 * Lists what calls a method or reads a property, anywhere in the project. `Find usages` on
 * a type answers with types; this one answers with call sites, which is what a public
 * member is asked about.
 */
export async function showMemberUsages(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const target = await memberAtCursor(file, editor.document.offsetAt(editor.selection.active));

  if (!target) {
    vscode.window.showInformationMessage('Put the cursor on a method, a property or a constant.');
    return;
  }

  const name = labelOf(target);
  const search = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Searching usages of ${name}…` },
    () => findMemberSites(target),
  );

  if (search.sites.length === 0) {
    vscode.window.showInformationMessage(`No usages found for ${name}.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(toItems(search.sites), {
    placeHolder: `${name} — ${search.sites.length} usages`,
    matchOnDescription: true,
  });

  if (picked?.site) {
    await reveal(picked.site);
  }
}
