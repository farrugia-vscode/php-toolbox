/**
 * The text with every comment blanked out, offsets and line breaks kept: what a regex
 * finds in the result sits at the same place in the file, and never inside a comment.
 *
 * Strings are walked over so a `//` in a URL is not taken for a comment; heredocs are
 * not, which a `/*` inside one would mislead.
 */
export function withoutComments(text: string): string {
  const output = text.split('');
  let index = 0;

  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at++) {
      if (output[at] !== '\n') {
        output[at] = ' ';
      }
    }
  };

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "'" || char === '"') {
      index = closingQuote(text, index) + 1;
      continue;
    }

    if ((char === '/' && next === '/') || (char === '#' && next !== '[')) {
      const end = text.indexOf('\n', index);
      const to = end === -1 ? text.length : end;

      blank(index, to);
      index = to;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const to = end === -1 ? text.length : end + 2;

      blank(index, to);
      index = to;
      continue;
    }

    index++;
  }

  return output.join('');
}

/** The offset of the quote closing the string opened at `open`, or the end of the text. */
function closingQuote(text: string, open: number): number {
  const quote = text[open];

  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === '\\') {
      index++;
    } else if (text[index] === quote) {
      return index;
    }
  }

  return text.length;
}
