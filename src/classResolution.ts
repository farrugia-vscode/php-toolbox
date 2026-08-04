import * as vscode from 'vscode';
import type { Definition } from './types';
import { CLASS_KINDS, findClassLikeSymbols } from './classSymbols';
import { findWordPosition, normalizeDefinition } from './typeReferences';

/** A class-like declaration: where it lives, and its parsed symbol. */
export interface ResolvedClass {
  uri: vscode.Uri;
  symbol: vscode.DocumentSymbol;
}

/**
 * Falls back to the workspace symbol index: definition providers usually ignore names
 * written inside a docblock, which is exactly where `@mixin` targets appear.
 */
async function findClassByName(name: string): Promise<Definition | null> {
  const shortName = name.split('\\').pop() ?? name;

  const symbols =
    (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      shortName,
    )) ?? [];

  const match = symbols.find(
    (symbol) => CLASS_KINDS.has(symbol.kind) && (symbol.name.split('\\').pop() ?? '') === shortName,
  );

  return match ? { uri: match.location.uri, position: match.location.range.start } : null;
}

/** The class-like symbol a definition landed in, or the one named `name` in that file. */
export async function classSymbolAt(
  definition: Definition,
  name?: string,
): Promise<ResolvedClass | null> {
  const shortName = name?.split('\\').pop();

  const symbols = findClassLikeSymbols(
    (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      definition.uri,
    )) ?? [],
  );

  const symbol =
    symbols.find((candidate) => candidate.range.contains(definition.position)) ??
    symbols.find((candidate) => (candidate.name.split('\\').pop() ?? '') === shortName);

  return symbol ? { uri: definition.uri, symbol } : null;
}

/** Resolves the type named at `position` — imports and aliases included, since PHP's own tooling answers. */
export async function resolveTypeAt(
  uri: vscode.Uri,
  position: vscode.Position,
  name: string,
): Promise<ResolvedClass | null> {
  const definition = normalizeDefinition(
    await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    ),
  );

  return definition ? classSymbolAt(definition, name) : null;
}

/** Resolves a type name as it is written in `document`, between the given lines. */
export async function resolveTypeName(
  document: vscode.TextDocument,
  name: string,
  fromLine: number,
  toLine: number,
): Promise<ResolvedClass | null> {
  const position = findWordPosition(document, name, fromLine, toLine);

  const resolved = position ? await resolveTypeAt(document.uri, position, name) : null;

  if (resolved) {
    return resolved;
  }

  const fallback = await findClassByName(name);

  return fallback ? classSymbolAt(fallback, name) : null;
}
