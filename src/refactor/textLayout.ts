/** Indentation and line helpers: generated code has to look like the code around it. */

export function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', Math.max(offset - 1, 0)) + 1;
}

export function lineEndOf(text: string, offset: number): number {
  const found = text.indexOf('\n', offset);

  return found === -1 ? text.length : found;
}

/** Leading whitespace of the line the offset sits on. */
export function indentAt(text: string, offset: number): string {
  const start = lineStartOf(text, offset);

  return /^[ \t]*/.exec(text.slice(start, lineEndOf(text, offset)))?.[0] ?? '';
}

/** One indentation step, read from the file rather than assumed. */
export function indentUnit(text: string): string {
  const tab = /\n\t+\S/.test(text);

  if (tab) {
    return '\t';
  }

  const widths = [...text.matchAll(/\n( +)\S/g)].map((match) => match[1].length);
  const smallest = widths.length > 0 ? Math.min(...widths) : 4;

  return ' '.repeat(smallest);
}

/** Moves a block of code from one indentation level to another, blank lines untouched. */
export function reindent(block: string, from: string, to: string): string {
  return block
    .split('\n')
    .map((line, index) => {
      if (index === 0) {
        return `${to}${line}`;
      }
      if (line.trim() === '') {
        return '';
      }

      return `${to}${line.startsWith(from) ? line.slice(from.length) : line.replace(/^[ \t]+/, '')}`;
    })
    .join('\n');
}

/** Start of the docblock written above a declaration, or the declaration itself. */
export function docblockStart(text: string, offset: number): number {
  const before = text.slice(0, lineStartOf(text, offset)).trimEnd();

  if (!before.endsWith('*/')) {
    return offset;
  }

  const opening = before.lastIndexOf('/**');

  return opening === -1 ? offset : opening;
}

/** Extends a removal over the blank line the member leaves behind. */
export function blankLineBefore(text: string, start: number): number {
  const previous = lineStartOf(text, start - 1);

  return start > 0 && text.slice(previous, start).trim() === '' ? previous : start;
}

/** The end of the line the offset sits on, newline included, so an insert lands cleanly after it. */
export function afterLine(text: string, offset: number): number {
  const end = lineEndOf(text, offset);

  return end === text.length ? end : end + 1;
}
