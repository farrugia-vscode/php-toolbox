import * as vscode from 'vscode';

/** Symbol kinds treated as class members worth listing. */
export const MEMBER_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Field,
  vscode.SymbolKind.EnumMember,
]);

/** Symbol kinds treated as class-like containers (class, interface, trait, enum). */
export const CLASS_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
]);

/** Codicon name per member kind, for the quick-pick label. */
export const KIND_ICON: Partial<Record<vscode.SymbolKind, string>> = {
  [vscode.SymbolKind.Method]: 'symbol-method',
  [vscode.SymbolKind.Property]: 'symbol-property',
  [vscode.SymbolKind.Constant]: 'symbol-constant',
  [vscode.SymbolKind.Field]: 'symbol-field',
  [vscode.SymbolKind.EnumMember]: 'symbol-enum-member',
};

/** Flattens the symbol tree to every class-like symbol it contains. */
export function findClassLikeSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const found: vscode.DocumentSymbol[] = [];
  const walk = (list: vscode.DocumentSymbol[]): void => {
    for (const symbol of list) {
      if (CLASS_KINDS.has(symbol.kind)) {
        found.push(symbol);
      }
      if (symbol.children && symbol.children.length > 0) {
        walk(symbol.children);
      }
    }
  };
  walk(symbols);
  return found;
}

/** The innermost class-like symbol containing `position`, or the first one otherwise. */
export function pickEnclosingClass(
  classSymbols: vscode.DocumentSymbol[],
  position: vscode.Position,
): vscode.DocumentSymbol {
  const containing = classSymbols.filter((symbol) => symbol.range.contains(position));
  if (containing.length > 0) {
    return containing.sort(
      (first, second) =>
        second.range.start.line - first.range.start.line || first.range.end.line - second.range.end.line,
    )[0];
  }
  return classSymbols[0];
}
