import type { Intention } from '.';
import type { TextEdit } from '../refactor/editSet';
import { docblockStart, lineEndOf, lineStartOf } from '../refactor/textLayout';

/**
 * Types only a static analyser understands. They look like class names, so nothing but a
 * list tells them apart from one — and writing them into a signature is a fatal error.
 */
const ANALYSER_ONLY = new Set([
  'class-string', 'interface-string', 'trait-string', 'enum-string', 'callable-string',
  'literal-string', 'non-empty-string', 'non-falsy-string', 'numeric-string', 'lowercase-string',
  'positive-int', 'negative-int', 'non-positive-int', 'non-negative-int', 'non-zero-int',
  'array-key', 'list', 'non-empty-list', 'non-empty-array', 'scalar', 'number', 'numeric',
  'resource', 'closed-resource', 'empty', 'truthy-string', 'key-of', 'value-of', 'int-mask',
  'int-mask-of', 'new', 'noreturn', 'no-return',
]);

/** Types PHP accepts as a return type and nowhere else. */
const RETURN_ONLY = new Set(['void', 'never', 'static']);

const SEGMENT = /^\\?[A-Za-z_][A-Za-z0-9_\\]*$/;

/** One `@param` or `@return` line, as the docblock wrote it. */
interface DocType {
  /** The type, `?` and `|null` kept as written. */
  written: string;
  /** Offsets of the whole line, so a redundant one can be dropped. */
  lineStart: number;
  lineEnd: number;
}

/**
 * True when a signature can carry the type as it stands.
 *
 * Anything a signature cannot say — the element type of an array, a shape, an intersection
 * whose precedence would have to be rewritten — belongs in the docblock and stays there.
 */
function isNative(written: string, position: 'param' | 'return'): boolean {
  if (/[<>{}\[\]&(),' ]/.test(written)) {
    return false;
  }

  const segments = written.replace(/^\?/, '').split('|');

  if (segments.length === 0 || (written.startsWith('?') && segments.length > 1)) {
    return false;
  }

  return segments.every((segment) => {
    const lowered = segment.toLowerCase();

    if (ANALYSER_ONLY.has(lowered) || lowered === '$this') {
      return false;
    }

    // `null` alone, and `void` on a parameter, are not types a signature takes.
    if (RETURN_ONLY.has(lowered)) {
      return position === 'return' && segments.length === 1;
    }

    if (lowered === 'null') {
      return segments.length > 1;
    }

    return SEGMENT.test(segment);
  });
}

/** The same type, written the way a comparison can see through: `?Foo` is `Foo|null`. */
function normalized(written: string): string {
  const bare = written.replace(/^\?/, '');
  const segments = written.startsWith('?') ? [bare, 'null'] : bare.split('|');

  return [...new Set(segments.map((segment) => segment.replace(/^\\/, '').toLowerCase()))].sort().join('|');
}

/** The docblock above the declaration, or null when there is none. */
function docblockAt(text: string, start: number): { start: number; end: number } | null {
  const opening = docblockStart(text, start);

  if (opening === start) {
    return null;
  }

  const closing = text.indexOf('*/', opening);

  return closing === -1 ? null : { start: opening, end: closing + 2 };
}

function typesFrom(text: string, block: { start: number; end: number }): { params: Map<string, DocType>; returns: DocType | null } {
  const params = new Map<string, DocType>();
  let returns: DocType | null = null;
  const body = text.slice(block.start, block.end);

  for (const match of body.matchAll(/@(param|return)\s+([^\s*]+)(?:\s+\$(\w+))?/g)) {
    const offset = block.start + (match.index ?? 0);
    const found: DocType = {
      written: match[2],
      lineStart: lineStartOf(text, offset),
      lineEnd: lineEndOf(text, offset),
    };

    if (match[1] === 'param' && match[3]) {
      params.set(match[3], found);
      continue;
    }

    if (match[1] === 'return') {
      returns = found;
    }
  }

  return { params, returns };
}

/** Where a return type goes: right after the closing parenthesis of the parameter list. */
function returnTypeAnchor(text: string, method: any): number | null {
  const end = method.body?.loc ? method.body.loc.start.offset : method.loc.end.offset;
  const closing = text.lastIndexOf(')', end);

  return closing === -1 ? null : closing + 1;
}

/** The lines the docblock spans, as offset ranges. */
function docLines(text: string, block: { start: number; end: number }): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = [];
  let cursor = block.start;

  while (cursor < block.end) {
    const end = lineEndOf(text, cursor);

    lines.push({ start: lineStartOf(text, cursor), end });
    cursor = end + 1;
  }

  return lines;
}

/** Whether the docblock has anything left to say once the moved lines are gone. */
function isEmptied(text: string, block: { start: number; end: number }, dropped: DocType[]): boolean {
  const removed = new Set(dropped.map((entry) => entry.lineStart));

  return docLines(text, block).every((line) => {
    if (removed.has(line.start)) {
      return true;
    }

    const bare = text
      .slice(line.start, line.end)
      .replace(/^\s*(\/\*\*|\*\/|\*)/, '')
      .replace(/\*\/\s*$/, '')
      .trim();

    return bare === '';
  });
}

/**
 * Moves the types a docblock states into the signature, where the engine enforces them.
 *
 * Only the types a signature can carry move, and a line is dropped only once it says
 * nothing the signature does not: `@param positive-int $count` outlives `int $count`.
 */
export function nativeTypesFromDocblock(text: string, chain: any[], offset: number): Intention | null {
  const method = chain.find((candidate) => candidate.kind === 'method' || candidate.kind === 'function');

  if (!method?.loc) {
    return null;
  }

  const block = docblockAt(text, method.loc.start.offset);
  const signatureEnd = method.body?.loc ? method.body.loc.start.offset : method.loc.end.offset;

  if (!block || offset < block.start || offset > signatureEnd) {
    return null;
  }

  const { params, returns } = typesFrom(text, block);
  const edits: TextEdit[] = [];
  const dropped: DocType[] = [];

  (method.arguments ?? []).forEach((argument: any) => {
    const name = typeof argument.name === 'string' ? argument.name : argument.name?.name;
    const documented = name ? params.get(name) : undefined;

    if (!documented || !isNative(documented.written, 'param')) {
      return;
    }

    const declared = argument.type
      ? text.slice(argument.type.loc.start.offset, argument.type.loc.end.offset).trim()
      : null;

    if (declared === null) {
      const anchor = argument.loc.start.offset;

      edits.push({ start: anchor, end: anchor, text: `${documented.written} ` });
      dropped.push(documented);
      return;
    }

    // Already enforced: the line only repeats what the reader can see one line down.
    if (normalized(argument.nullable === true && !declared.startsWith('?') ? `?${declared}` : declared) === normalized(documented.written)) {
      dropped.push(documented);
    }
  });

  const anchor = returnTypeAnchor(text, method);

  if (returns && anchor !== null && isNative(returns.written, 'return')) {
    const declared = method.type
      ? text.slice(method.type.loc.start.offset, method.type.loc.end.offset).trim()
      : null;

    if (declared === null) {
      edits.push({ start: anchor, end: anchor, text: `: ${returns.written}` });
      dropped.push(returns);
    } else if (normalized(method.nullable === true && !declared.startsWith('?') ? `?${declared}` : declared) === normalized(returns.written)) {
      dropped.push(returns);
    }
  }

  if (edits.length === 0) {
    return null;
  }

  if (isEmptied(text, block, dropped)) {
    // Nothing left but the frame: the docblock goes with the lines it held.
    edits.push({ start: block.start, end: Math.min(lineEndOf(text, block.end) + 1, text.length), text: '' });
  } else {
    dropped.forEach((entry) => edits.push({ start: entry.lineStart, end: Math.min(entry.lineEnd + 1, text.length), text: '' }));
  }

  return { title: 'Move PHPDoc types into the signature', edits };
}
