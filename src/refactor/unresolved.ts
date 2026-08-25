import * as vscode from 'vscode';
import type { IndexedFile } from '../php/phpIndex';

/** A mention of the right name whose receiver said nothing about what it holds. */
export interface UnresolvedSite {
  file: IndexedFile;
  nameStart: number;
  nameEnd: number;
}

function lineAt(site: UnresolvedSite): string {
  const start = site.file.text.lastIndexOf('\n', site.nameStart) + 1;
  const end = site.file.text.indexOf('\n', site.nameEnd);

  return site.file.text.slice(start, end === -1 ? undefined : end).trim();
}

function lineNumber(site: UnresolvedSite): number {
  return site.file.text.slice(0, site.nameStart).split('\n').length;
}

/**
 * Tells the user about the mentions a refactoring left alone.
 *
 * Nothing declared what their receiver holds, so nothing says they reach the member being
 * changed — rewriting them on the strength of a shared name is how an unrelated file ends
 * up edited. They are reported instead: the one thing worse than not touching them would
 * be to say nothing about it.
 */
export async function reportUnresolved(name: string, sites: UnresolvedSite[]): Promise<void> {
  if (sites.length === 0) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `${sites.length} mention(s) of ${name} were left untouched: nothing declares what their receiver holds.`,
    'Show them',
  );

  if (answer !== 'Show them') {
    return;
  }

  const picked = await vscode.window.showQuickPick(
    sites.map((site) => ({
      label: lineAt(site),
      description: `${vscode.workspace.asRelativePath(site.file.uri)} · line ${lineNumber(site)}`,
      site,
    })),
    { placeHolder: `${name} — ${sites.length} unresolved mention(s)`, matchOnDescription: true },
  );

  if (!picked) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(picked.site.file.uri);
  const editor = await vscode.window.showTextDocument(document);
  const range = picked.site.file.mapper.range(picked.site.nameStart, picked.site.nameEnd);

  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}
