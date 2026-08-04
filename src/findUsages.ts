import * as vscode from 'vscode';
import { findClassLikeSymbols, pickEnclosingClass } from './classSymbols';
import { CATEGORY_ORDER, findUsages, type Usage } from './usages';

const MAX_CODE = 100;

interface UsageQuickPickItem extends vscode.QuickPickItem {
  usage?: Usage;
}

/** Short name of the class, interface or trait the cursor sits in. */
export async function typeAtCursor(editor: vscode.TextEditor): Promise<string | null> {
  const symbols =
    (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      editor.document.uri,
    )) ?? [];

  const classSymbols = findClassLikeSymbols(symbols);
  if (classSymbols.length === 0) {
    return null;
  }

  const symbol = pickEnclosingClass(classSymbols, editor.selection.active);
  return symbol.name.split('\\').pop() ?? null;
}

/**
 * One separator per category, so implementations are not drowned among type hints.
 */
function toItems(usages: Usage[]): UsageQuickPickItem[] {
  const items: UsageQuickPickItem[] = [];

  for (const category of CATEGORY_ORDER) {
    const inCategory = usages.filter((usage) => usage.category === category);
    if (inCategory.length === 0) {
      continue;
    }

    items.push({
      label: `${category} (${inCategory.length})`,
      kind: vscode.QuickPickItemKind.Separator,
    });

    inCategory
      .sort((first, second) => first.uri.fsPath.localeCompare(second.uri.fsPath))
      .forEach((usage) => {
        const file = vscode.workspace.asRelativePath(usage.uri);
        const code = usage.code.length > MAX_CODE ? `${usage.code.slice(0, MAX_CODE)}…` : usage.code;

        items.push({
          label: `$(file-code)  ${file.split('/').pop()}`,
          description: `${file} · line ${usage.range.start.line + 1}`,
          detail: `        ${code}`,
          usage,
        });
      });
  }

  return items;
}

/** Narrows the search to what the caller asked for: an interface is looked up for its implementations. */
export interface UsagesSearch {
  categories?: string[];
  label?: string;
}

export async function showUsages(search: UsagesSearch = {}): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const name = await typeAtCursor(editor);
  if (!name) {
    vscode.window.showInformationMessage('No class, interface or trait found in this file.');
    return;
  }

  const label = search.label ?? 'usages';
  const source = new vscode.CancellationTokenSource();
  const found = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Searching ${label} of ${name}…`, cancellable: true },
    (_progress, token) => {
      token.onCancellationRequested(() => source.cancel());
      return findUsages(name, editor.document.uri, source.token);
    },
  );

  const usages = search.categories
    ? found.filter((usage) => search.categories?.includes(usage.category))
    : found;

  if (usages.length === 0) {
    vscode.window.showInformationMessage(`No ${label} found for ${name}.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(toItems(usages), {
    placeHolder: `${name} — ${usages.length} ${label}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked?.usage) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(picked.usage.uri);
  const opened = await vscode.window.showTextDocument(document);
  opened.selection = new vscode.Selection(picked.usage.range.start, picked.usage.range.end);
  opened.revealRange(picked.usage.range, vscode.TextEditorRevealType.InCenter);
}
