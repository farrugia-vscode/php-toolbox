import * as vscode from 'vscode';
import { findClassLikeSymbols, pickEnclosingClass } from './classSymbols';
import { getPhpIndex, indexedFile, type IndexedFile } from './php/phpIndex';

const KIND_ICONS: Partial<Record<string, vscode.SymbolKind>> = {
  class: vscode.SymbolKind.Class,
  interface: vscode.SymbolKind.Interface,
  trait: vscode.SymbolKind.Struct,
  enum: vscode.SymbolKind.Enum,
};

/** Everything a declaration says it is built from: parent, interfaces and traits. */
function ancestorsOf(file: IndexedFile, fqn: string): string[] {
  const declaration = file.parsed.declarations.find((candidate) => candidate.fqn === fqn);

  if (!declaration) {
    return [];
  }

  return [declaration.parent, ...declaration.interfaces, ...declaration.traits].filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
}

function itemFor(file: IndexedFile, fqn: string): vscode.TypeHierarchyItem | null {
  const declaration = file.parsed.declarations.find((candidate) => candidate.fqn === fqn);

  if (!declaration) {
    return null;
  }

  const range = file.mapper.range(declaration.start, declaration.end);

  return {
    name: declaration.name,
    kind: KIND_ICONS[declaration.kind] ?? vscode.SymbolKind.Class,
    detail: declaration.fqn.split('\\').slice(0, -1).join('\\'),
    uri: file.uri,
    range,
    selectionRange: range,
  };
}

/** The file declaring a type, out of the whole project. */
function fileDeclaring(files: IndexedFile[], fqn: string): IndexedFile | null {
  return files.find((file) => file.parsed.declarations.some((candidate) => candidate.fqn === fqn)) ?? null;
}

/**
 * The class tree, both ways: what a type is built from, and what is built from it. Reading
 * a hierarchy by opening files one by one is exactly what this replaces.
 */
export class PhpTypeHierarchyProvider implements vscode.TypeHierarchyProvider {
  async prepareTypeHierarchy(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.TypeHierarchyItem[]> {
    const symbols = findClassLikeSymbols(
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      )) ?? [],
    );

    if (symbols.length === 0) {
      return [];
    }

    const enclosing = pickEnclosingClass(symbols, position);
    const file = indexedFile(document.uri, document.getText());
    const declaration = file.parsed.declarations.find(
      (candidate) => candidate.name === enclosing.name.split('\\').pop(),
    );
    const item = declaration ? itemFor(file, declaration.fqn) : null;

    return item ? [item] : [];
  }

  async provideTypeHierarchySupertypes(
    item: vscode.TypeHierarchyItem,
  ): Promise<vscode.TypeHierarchyItem[]> {
    const files = await getPhpIndex();
    const own = fileDeclaring(files, this.fqnOf(files, item));

    if (!own) {
      return [];
    }

    return ancestorsOf(own, this.fqnOf(files, item))
      .map((fqn) => {
        const declaring = fileDeclaring(files, fqn);
        return declaring ? itemFor(declaring, fqn) : null;
      })
      .filter((found): found is vscode.TypeHierarchyItem => found !== null);
  }

  async provideTypeHierarchySubtypes(
    item: vscode.TypeHierarchyItem,
  ): Promise<vscode.TypeHierarchyItem[]> {
    const files = await getPhpIndex();
    const fqn = this.fqnOf(files, item);
    const found: vscode.TypeHierarchyItem[] = [];

    for (const file of files) {
      for (const declaration of file.parsed.declarations) {
        if (ancestorsOf(file, declaration.fqn).includes(fqn)) {
          const child = itemFor(file, declaration.fqn);

          if (child) {
            found.push(child);
          }
        }
      }
    }

    return found;
  }

  /** The item carries only its short name, so the namespace comes back from its file. */
  private fqnOf(files: IndexedFile[], item: vscode.TypeHierarchyItem): string {
    const declaring = files.find((file) => file.uri.toString() === item.uri.toString());
    const declaration = declaring?.parsed.declarations.find((candidate) => candidate.name === item.name);

    return declaration?.fqn ?? item.name;
  }
}
