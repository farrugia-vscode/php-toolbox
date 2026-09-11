/**
 * Reading the docblock above a declaration, without a parser: the AST is built without
 * comments, and a comment has too little structure for one to be worth it.
 */

/**
 * The docblock a declaration sits under: the last `/** ... *\/` before it, with nothing
 * but attributes and blank lines in between.
 */
export function docblockBefore(text: string, offset: number): string | null {
  const before = text.slice(0, offset);
  const start = before.lastIndexOf('/**');
  const end = start === -1 ? -1 : before.indexOf('*/', start);

  if (end === -1 || !/^(?:\s|#\[[^\n]*\]|final|abstract|readonly)*$/.test(before.slice(end + 2))) {
    return null;
  }

  return before.slice(start, end + 2);
}

/**
 * The type written at `from`, read up to the first space outside angle brackets: a
 * `Collection<int, Invoice>` has a space of its own, so a word is not enough.
 */
export function readType(text: string, from: number): { type: string; end: number } {
  let depth = 0;
  let end = from;

  while (end < text.length) {
    const char = text[end];

    if (char === '<') {
      depth++;
    } else if (char === '>') {
      depth--;
    } else if (/\s/.test(char) && depth === 0) {
      break;
    }

    end++;
  }

  return { type: text.slice(from, end), end };
}

/** The type a `@return` or `@var` tag writes in the docblock, or null when the docblock says none. */
export function taggedTypeBefore(text: string, offset: number, tag: 'return' | 'var'): string | null {
  const docblock = docblockBefore(text, offset);
  const match = docblock === null ? null : new RegExp(`@${tag}\\s+`).exec(docblock);

  if (docblock === null || match === null) {
    return null;
  }

  const { type } = readType(docblock, match.index + match[0].length);

  return type === '' ? null : type;
}
