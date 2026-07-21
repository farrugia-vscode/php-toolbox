import * as vscode from 'vscode';
import type { Definition } from './types';

/** Parent/interface/trait names referenced by a class, plus its header line range. */
export interface TypeReferences {
  names: Set<string>;
  headerRange: [number, number];
  traitNames: Set<string>;
}

/** Extracts `extends`/`implements` targets and `use` traits declared by a class. */
export function parseTypeReferences(
  document: vscode.TextDocument,
  classSymbol: vscode.DocumentSymbol,
): TypeReferences {
  const names = new Set<string>();
  const startLine = classSymbol.selectionRange.start.line;
  const endLine = classSymbol.range.end.line;

  // `@mixin` brings in members just like inheritance does, and Laravel leans on it
  // heavily (ide-helper, Eloquent builders). The docblock sits above the class.
  const docStart = collectMixins(document, startLine, names);

  // Header: everything from the class name line up to the opening brace.
  let header = '';
  let headerEndLine = startLine;
  for (let line = startLine; line <= endLine && line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    header += ' ' + text;
    headerEndLine = line;
    if (text.includes('{')) {
      break;
    }
  }

  const collect = (regex: RegExp): void => {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(header)) !== null) {
      match[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => names.add(name));
    }
  };
  collect(/\bextends\s+([\w\\,\s]+?)(?:\bimplements\b|\{|$)/g);
  collect(/\bimplements\s+([\w\\,\s]+?)(?:\{|$)/g);

  // Trait uses inside the class body.
  const traitNames = new Set<string>();
  for (let line = headerEndLine; line <= endLine && line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = /^\s*use\s+([A-Za-z_\\][\w\\]*(?:\s*,\s*[A-Za-z_\\][\w\\]*)*)\s*[;{]/.exec(text);
    if (match) {
      match[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => {
          names.add(name);
          traitNames.add(name);
        });
    }
  }

  return { names, headerRange: [docStart, headerEndLine], traitNames };
}

/**
 * Reads `@mixin` targets from the docblock preceding the class, and returns the line
 * the search for those names should start from.
 */
function collectMixins(
  document: vscode.TextDocument,
  startLine: number,
  names: Set<string>,
): number {
  let line = startLine - 1;

  // Skip attributes and blank lines sitting between the docblock and the class.
  while (line >= 0 && /^\s*(#\[|$)/.test(document.lineAt(line).text)) {
    line--;
  }

  if (line < 0 || !/\*\/\s*$/.test(document.lineAt(line).text)) {
    return startLine;
  }

  const docEnd = line;

  while (line >= 0 && !/^\s*\/\*\*/.test(document.lineAt(line).text)) {
    line--;
  }

  const docStart = Math.max(line, 0);

  for (let current = docStart; current <= docEnd; current++) {
    const match = /@mixin\s+\\?([\w\\]+)/.exec(document.lineAt(current).text);

    if (match) {
      names.add(match[1]);
    }
  }

  return docStart;
}

/** Finds the position of `word`'s short name within a line range, or null. */
export function findWordPosition(
  document: vscode.TextDocument,
  word: string,
  fromLine: number,
  toLine: number,
): vscode.Position | null {
  const shortName = word.split('\\').pop() ?? word;
  const pattern = new RegExp(`\\b${shortName}\\b`);
  for (let line = fromLine; line <= toLine && line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = pattern.exec(text);
    if (match) {
      return new vscode.Position(line, match.index);
    }
  }
  return null;
}

/** Reduces a definition-provider result to its first location (uri + start). */
export function normalizeDefinition(
  result: Array<vscode.Location | vscode.LocationLink> | undefined,
): Definition | null {
  if (!result || result.length === 0) {
    return null;
  }
  const first = result[0];
  if ('targetUri' in first) {
    return { uri: first.targetUri, position: (first.targetSelectionRange ?? first.targetRange).start };
  }
  return { uri: first.uri, position: first.range.start };
}
