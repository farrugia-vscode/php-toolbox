import * as vscode from 'vscode';
import { findClassLikeSymbols, pickEnclosingClass } from './classSymbols';
import { categoryOrder, findUsages, type Usage } from './usages';
import { showUsagesView, type UsageGroup } from './usagesView';

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

/** One heading per category, so implementations are not drowned among type hints. */
function groupByCategory(usages: Usage[]): UsageGroup[] {
  return categoryOrder().map((category) => ({
    label: category,
    entries: usages
      .filter((usage) => usage.category === category)
      .map((usage) => ({ uri: usage.uri, range: usage.range, label: usage.code })),
  }));
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

  await showUsagesView({ subject: name, unit: label, groups: groupByCategory(usages) });
}
