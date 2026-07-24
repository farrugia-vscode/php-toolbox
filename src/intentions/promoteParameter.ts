import { parseFile } from '../php/parser';
import type { TextEdit } from '../refactor/editSet';
import { afterLine, blankLineBefore, docblockStart, lineStartOf } from '../refactor/textLayout';
import type { Intention } from './index';

const cache = new Map<string, ReturnType<typeof parseFile>>();

/** Parsed form of the file being edited, kept for as long as the text does not change. */
function parsedOf(text: string): ReturnType<typeof parseFile> {
  const known = cache.get(text);

  if (known) {
    return known;
  }

  const parsed = parseFile(text);
  cache.clear();
  cache.set(text, parsed);

  return parsed;
}

/**
 * Turns a constructor parameter into a promoted property: the declaration above and the
 * `$this->x = $x;` line below both become noise once the signature says it.
 */
export function promoteParameter(text: string, offset: number): Intention | null {
  const parsed = parsedOf(text);
  const constructor = parsed.methods.find(
    (method) => method.name === '__construct' && offset >= method.paramsStart && offset <= method.paramsEnd,
  );
  const param = constructor?.params.find((candidate) => offset >= candidate.start && offset <= candidate.end);

  if (!constructor || !param || param.isPromoted || param.isVariadic) {
    return null;
  }

  const property = parsed.properties.find(
    (candidate) =>
      candidate.className === constructor.className &&
      candidate.name === param.name &&
      !candidate.isStatic &&
      candidate.start < constructor.start,
  );

  const edits: TextEdit[] = [];
  const visibility = property?.visibility ?? 'private';
  const type = param.type ?? property?.type;

  edits.push({
    start: param.start,
    end: param.start,
    text: `${visibility} ${param.type || !type ? '' : `${type} `}`,
  });

  if (property) {
    const start = blankLineBefore(text, lineStartOf(text, docblockStart(text, property.start)));

    edits.push({ start, end: afterLine(text, property.end), text: '' });
  }

  const body = constructor.bodyStart !== null ? text.slice(constructor.bodyStart, constructor.bodyEnd ?? 0) : '';
  const assignment = new RegExp(`^[ \\t]*\\$this->${param.name}\\s*=\\s*\\$${param.name}\\s*;[ \\t]*\\n?`, 'm').exec(body);

  if (assignment && constructor.bodyStart !== null) {
    const start = constructor.bodyStart + assignment.index;

    edits.push({ start, end: start + assignment[0].length, text: '' });
  }

  return { title: `Promote $${param.name} to a property`, edits };
}
