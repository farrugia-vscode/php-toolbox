import * as vscode from 'vscode';
import { getIndex } from './workspaceIndex';

/** A usage of a type, labelled by what the code actually does with it. */
export interface Usage {
  category: string;
  uri: vscode.Uri;
  range: vscode.Range;
  code: string;
}

/**
 * Ordered so the answers people look for first — who implements this, who extends it —
 * come before the incidental mentions.
 */
const CATEGORIES: Array<{ category: string; pattern: (name: string) => string }> = [
  {
    category: 'Implemented by',
    pattern: (name) => `\\bimplements\\b[^{]*?\\\\?[\\w\\\\]*?\\b(${name})\\b`,
  },
  {
    category: 'Extended by',
    pattern: (name) => `\\bextends\\s+\\\\?[\\w\\\\]*?\\b(${name})\\b`,
  },
  {
    category: 'Used as a trait',
    pattern: (name) => `^\\s*use\\s+\\\\?[\\w\\\\]*?\\b(${name})\\b\\s*[;{]`,
  },
  {
    category: 'Instantiated',
    pattern: (name) => `\\bnew\\s+\\\\?[\\w\\\\]*?\\b(${name})\\s*\\(`,
  },
  {
    category: 'Injected or type hinted',
    pattern: (name) =>
      `(?:[(,]\\s*(?:(?:public|protected|private|readonly)\\s+)*\\??\\\\?[\\w\\\\]*?\\b(${name})\\b\\s+[.$&]|:\\s*\\??\\\\?[\\w\\\\]*?\\b(${name})\\b)`,
  },
  {
    category: 'Static access',
    pattern: (name) => `\\b(${name})::`,
  },
];

/** An import line is a reference, not a usage: it says nothing about what the code does. */
const IMPORT = /^\s*use\s+[\w\\]+\s*(?:as\s+\w+\s*)?;\s*$/;

const DECLARATION = /^\s*(?:final\s+|abstract\s+|readonly\s+)*(?:class|interface|trait|enum)\s+/;

function positionOf(text: string, offset: number): vscode.Position {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  const lineStart = before.lastIndexOf('\n') + 1;
  return new vscode.Position(line, offset - lineStart);
}

/**
 * Every place the workspace does something with `name`, grouped by what it does.
 *
 * Matching is textual: a PHP parser would be more exact, but running one over a whole
 * project takes seconds, which no one waits for.
 */
export async function findUsages(
  name: string,
  selfUri: vscode.Uri,
  token: vscode.CancellationToken,
): Promise<Usage[]> {
  const files = await getIndex();
  const usages: Usage[] = [];

  for (const [uri, text] of files) {
    if (token.isCancellationRequested) {
      return usages;
    }
    if (!text.includes(name)) {
      continue;
    }

    const target = vscode.Uri.parse(uri);
    const lines = text.split('\n');

    for (const { category, pattern } of CATEGORIES) {
      const regex = new RegExp(pattern(name), 'gm');
      let match = regex.exec(text);

      while (match !== null) {
        const found = match.slice(1).find((group) => group !== undefined);

        if (found) {
          const start = positionOf(text, match.index + match[0].lastIndexOf(found));
          const code = (lines[start.line] ?? '').trim();
          const isSelf = target.toString() === selfUri.toString();

          if (!IMPORT.test(code) && !(isSelf && DECLARATION.test(code))) {
            usages.push({
              category,
              uri: target,
              range: new vscode.Range(start, start.translate(0, found.length)),
              code,
            });
          }
        }

        match = regex.exec(text);
      }
    }
  }

  return dedupe(usages);
}

/** The same line can match two categories; the first one wins, as they are ordered. */
function dedupe(usages: Usage[]): Usage[] {
  const seen = new Set<string>();

  return usages.filter((usage) => {
    const key = `${usage.uri.toString()}:${usage.range.start.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export const CATEGORY_ORDER = CATEGORIES.map(({ category }) => category);

/** Honouring a contract: what "find implementations" means for an interface or an abstract class. */
export const IMPLEMENTATION_CATEGORIES = ['Implemented by', 'Extended by'];

/** A trait has no implementations; it has classes that pull it in. */
export const TRAIT_USER_CATEGORIES = ['Used as a trait'];
