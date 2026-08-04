/** Reads back from a `->` completion to the member call the receiver comes from. */

export interface ReceiverMember {
  name: string;
  /** Offset of the first character of the name, in the text it was read from. */
  offset: number;
}

/** A call written over more than a few lines is not worth scanning back through. */
const SCAN_LIMIT = 4000;

function isNameChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function isSpaceChar(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function skipNameBackwards(text: string, offset: number): number {
  let cursor = offset;
  while (cursor > 0 && isNameChar(text[cursor - 1])) {
    cursor--;
  }
  return cursor;
}

function skipSpaceBackwards(text: string, offset: number): number {
  let cursor = offset;
  while (cursor > 0 && isSpaceChar(text[cursor - 1])) {
    cursor--;
  }
  return cursor;
}

/** Start of the string whose closing quote sits at `closeOffset`, or null when unterminated. */
function openingQuote(text: string, closeOffset: number): number | null {
  const quote = text[closeOffset];

  for (let index = closeOffset - 1; index >= 0; index--) {
    if (text[index] !== quote) {
      continue;
    }

    let backslashes = 0;
    while (text[index - 1 - backslashes] === '\\') {
      backslashes++;
    }

    if (backslashes % 2 === 0) {
      return index;
    }
  }

  return null;
}

/** Offset of the `(` matching the `)` at `closeOffset`, ignoring parentheses inside strings. */
function openingParen(text: string, closeOffset: number): number | null {
  let depth = 0;
  const stop = Math.max(0, closeOffset - SCAN_LIMIT);

  for (let index = closeOffset; index >= stop; index--) {
    const char = text[index];

    if (char === "'" || char === '"') {
      const opening = openingQuote(text, index);
      if (opening === null) {
        return null;
      }
      index = opening;
      continue;
    }

    if (char === ')') {
      depth++;
      continue;
    }

    if (char === '(') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }

  return null;
}

/**
 * The member whose type decides what `->` can offer at `offset`, for a chain such as
 * `$invoice->customer()->…`. Returns null when the receiver is a variable: its type comes
 * from an assignment rather than from a declaration, which is a different resolution.
 */
export function findReceiverMember(text: string, offset: number): ReceiverMember | null {
  let cursor = skipNameBackwards(text, offset);

  if (text.slice(cursor - 2, cursor) !== '->') {
    return null;
  }
  cursor -= 2;

  if (text[cursor - 1] === '?') {
    cursor--;
  }

  cursor = skipSpaceBackwards(text, cursor);

  if (text[cursor - 1] === ')') {
    const opening = openingParen(text, cursor - 1);
    if (opening === null) {
      return null;
    }
    cursor = skipSpaceBackwards(text, opening);
  }

  const nameEnd = cursor;
  const nameStart = skipNameBackwards(text, nameEnd);

  if (nameStart === nameEnd || text[nameStart - 1] === '$') {
    return null;
  }

  return { name: text.slice(nameStart, nameEnd), offset: nameStart };
}

/**
 * The variable a `->` hangs off at `offset`, for `$site->…`. The counterpart of
 * {@link findReceiverMember}: a variable takes its type from an assignment or a
 * declaration, never from the member it was called on.
 */
export function findReceiverVariable(text: string, offset: number): ReceiverMember | null {
  let cursor = skipNameBackwards(text, offset);

  if (text.slice(cursor - 2, cursor) !== '->') {
    return null;
  }
  cursor -= 2;

  if (text[cursor - 1] === '?') {
    cursor--;
  }

  cursor = skipSpaceBackwards(text, cursor);

  const nameEnd = cursor;
  const nameStart = skipNameBackwards(text, nameEnd);

  if (nameStart === nameEnd || text[nameStart - 1] !== '$') {
    return null;
  }

  // The offset points at the `$`, where a hover on the variable has to be asked for.
  return { name: text.slice(nameStart, nameEnd), offset: nameStart - 1 };
}

/** A `->member` written at `offset`, with the offsets of the member name itself. */
export interface MemberAccess {
  name: string;
  start: number;
  end: number;
}

/** The `->member` the cursor sits on, for a hover or a go-to-definition. */
export function findMemberAccess(text: string, offset: number): MemberAccess | null {
  const start = skipNameBackwards(text, offset);
  let end = offset;

  while (isNameChar(text[end])) {
    end++;
  }

  if (start === end || text.slice(start - 2, start) !== '->') {
    return null;
  }

  return { name: text.slice(start, end), start, end };
}
