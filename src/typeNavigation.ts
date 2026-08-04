import * as vscode from 'vscode';
import { MEMBER_KINDS, findClassLikeSymbols, pickEnclosingClass } from './classSymbols';
import { docblockRange, parseTypeReferences } from './typeReferences';
import { findMemberAccess } from './php/receiverChain';
import { isQueryingServer, receiverClassAt, resolveVariable, typeOfMember } from './mixinResolution';
import { resolveTypeName, type ResolvedClass } from './classResolution';

const MAX_DEPTH = 15;

/** The word the cursor sits on, and whether it is written as a variable. */
function wordAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): { name: string; isVariable: boolean } | null {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);

  if (!range) {
    return null;
  }

  const before = range.start.character === 0 ? '' : document.lineAt(range.start.line).text.charAt(range.start.character - 1);

  return { name: document.getText(range), isVariable: before === '$' };
}

function locationOf(target: ResolvedClass): vscode.Location {
  return new vscode.Location(target.uri, target.symbol.selectionRange);
}

/**
 * Jumps from a value to the class it holds: on `$site` to the model, on `$site->customer`
 * to the class of that attribute, whether it is declared in code or in a `@property`.
 */
export class PhpTypeDefinitionProvider implements vscode.TypeDefinitionProvider {
  async provideTypeDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location | undefined> {
    if (isQueryingServer()) {
      return undefined;
    }

    const word = wordAt(document, position);

    if (!word || token.isCancellationRequested) {
      return undefined;
    }

    if (word.isVariable) {
      const resolved = await resolveVariable(document, position, word.name);

      return resolved ? locationOf(resolved.target) : undefined;
    }

    const access = findMemberAccess(document.getText(), document.offsetAt(position));

    if (!access) {
      return undefined;
    }

    const receiver = await receiverClassAt(document, access.start);
    const held = receiver ? await typeOfMember(receiver.target, access.name) : null;

    return held ? locationOf(held) : undefined;
  }
}

/** The member of that name declared by the class, if it declares one. */
function memberSymbol(target: ResolvedClass, name: string): vscode.DocumentSymbol | null {
  return (
    (target.symbol.children ?? []).find(
      (child) => MEMBER_KINDS.has(child.kind) && child.name.replace(/^\$/, '') === name,
    ) ?? null
  );
}

/**
 * Walks up from a class to every ancestor declaring the given member. Interfaces and
 * abstract classes are what the reader is after — the contract the method answers.
 */
async function declaringAncestors(
  start: ResolvedClass,
  name: string,
  seen = new Set<string>(),
  depth = 0,
): Promise<vscode.Location[]> {
  const key = `${start.uri.toString()}#${start.symbol.name}`;

  if (depth > MAX_DEPTH || seen.has(key)) {
    return [];
  }
  seen.add(key);

  const document = await vscode.workspace.openTextDocument(start.uri);
  const { names } = parseTypeReferences(document, start.symbol);
  const classLine = start.symbol.selectionRange.start.line;
  const fromLine = docblockRange(document, classLine)?.[0] ?? classLine;
  const found: vscode.Location[] = [];

  for (const parentName of names) {
    const parent = await resolveTypeName(document, parentName, fromLine, start.symbol.range.end.line);

    if (!parent) {
      continue;
    }

    const member = memberSymbol(parent, name);

    if (member) {
      found.push(new vscode.Location(parent.uri, member.selectionRange));
    }

    found.push(...(await declaringAncestors(parent, name, seen, depth + 1)));
  }

  return found;
}

/**
 * Sends `Go to Declaration` on a method to the interface or abstract class it answers,
 * where `Go to Definition` would only land back on the method itself.
 */
export class PhpDeclarationProvider implements vscode.DeclarationProvider {
  async provideDeclaration(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    if (isQueryingServer()) {
      return undefined;
    }

    const word = wordAt(document, position);

    if (!word || word.isVariable) {
      return undefined;
    }

    const symbols = findClassLikeSymbols(
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      )) ?? [],
    );

    if (symbols.length === 0 || token.isCancellationRequested) {
      return undefined;
    }

    const enclosing: ResolvedClass = {
      uri: document.uri,
      symbol: pickEnclosingClass(symbols, position),
    };

    // Only from the declaration line: a call site already goes to the implementation.
    const member = memberSymbol(enclosing, word.name);

    if (!member || !member.selectionRange.contains(position)) {
      return undefined;
    }

    const found = await declaringAncestors(enclosing, word.name);

    return found.length > 0 ? found : undefined;
  }
}
