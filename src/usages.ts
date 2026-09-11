import * as vscode from 'vscode';
import { usageProviders, type UsageSymbol } from './api';
import { indexedFile } from './php/phpIndex';
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

  return [...dedupe(usages), ...(await providedUsages(name, selfUri, files.get(selfUri.toString()) ?? '', token))];
}

/**
 * What the other extensions know about the type: a framework sees a class dispatched or
 * listened to where the code only shows a name.
 */
async function providedUsages(
  name: string,
  selfUri: vscode.Uri,
  selfText: string,
  token: vscode.CancellationToken,
): Promise<Usage[]> {
  const providers = usageProviders();

  if (providers.length === 0) {
    return [];
  }

  const declaration = indexedFile(selfUri, selfText).parsed.declarations.find((candidate) => candidate.name === name);

  if (!declaration) {
    return [];
  }

  const symbol: UsageSymbol = { name, fqn: declaration.fqn, kind: declaration.kind, uri: selfUri };
  const usages: Usage[] = [];

  for (const provider of providers) {
    if (token.isCancellationRequested) {
      return usages;
    }

    // Another extension's failure is not this one's to fix, and hiding every lens of the
    // file behind it would only hide where the failure comes from.
    const entries = await provider.find(symbol, token).catch((error: unknown) => {
      console.error(`PHP Toolbox: the "${provider.category}" usage provider failed`, error);

      return [];
    });

    usages.push(...entries.map((entry) => ({ category: provider.category, uri: entry.uri, range: entry.range, code: entry.label })));
  }

  return usages;
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

const BUILT_IN_CATEGORIES = CATEGORIES.map(({ category }) => category);

/** The headings of a listing, in reading order: what the code shows first, then what the other extensions add. */
export function categoryOrder(): string[] {
  return [...BUILT_IN_CATEGORIES, ...usageProviders().map((provider) => provider.category)];
}

/** Honouring a contract: what "find implementations" means for an interface. */
export const IMPLEMENTATION_CATEGORIES = ['Implemented by', 'Extended by'];

/** A trait has no implementations; it has classes that pull it in. */
export const TRAIT_USER_CATEGORIES = ['Used as a trait'];

/** A class is not implemented, it is extended. */
export const SUBTYPE_CATEGORIES = ['Extended by'];

/** Types built on top of this one, whatever the kind: what the second lens stands for. */
export function descendantSearch(kind: string): { categories: string[]; label: string } {
  if (kind === 'interface') {
    return { categories: IMPLEMENTATION_CATEGORIES, label: 'implementations' };
  }

  if (kind === 'trait') {
    return { categories: TRAIT_USER_CATEGORIES, label: 'trait users' };
  }

  return { categories: SUBTYPE_CATEGORIES, label: 'subtypes' };
}

/**
 * What is left once the descendants have a listing of their own: repeating them under
 * "references" would only make the answer to "who is built on this" harder to find.
 */
export function referenceCategories(): string[] {
  return categoryOrder().filter(
    (category) => ![...IMPLEMENTATION_CATEGORIES, ...TRAIT_USER_CATEGORIES].includes(category),
  );
}
