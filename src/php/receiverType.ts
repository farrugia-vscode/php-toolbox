/**
 * What a receiver expression was proven to hold.
 *
 * The three answers are not degrees of confidence, they are different facts: `type` names
 * the class reached, `foreign` says the class is one the project does not declare — so no
 * refactoring of ours can concern it — and `unknown` says nothing said what it holds.
 */
export type Resolution =
  | { kind: 'type'; fqn: string }
  | { kind: 'foreign' }
  | { kind: 'unknown' };

export const FOREIGN: Resolution = { kind: 'foreign' };
export const UNKNOWN: Resolution = { kind: 'unknown' };

export function typeResolution(fqn: string): Resolution {
  return { kind: 'type', fqn };
}

/** Type names that name no class, so nothing of ours can hide behind them. */
const NON_CLASS_TYPES = new Set([
  'array', 'bool', 'boolean', 'callable', 'false', 'float', 'int', 'iterable', 'mixed',
  'never', 'null', 'object', 'string', 'true', 'void', '$this', 'self', 'static', 'parent',
]);

/** Types answered by the declaring class itself: a fluent `Builder::where(): static`. */
const SELF_TYPES = new Set(['$this', 'self', 'static']);

/** One step of a chain: `->name`, `?->name`, `::name`, called or not. */
export interface ChainLink {
  name: string;
  isCall: boolean;
}

export interface Chain {
  /** The expression the chain starts from, as written: `$this`, `$order`, `DB`, `new Foo()`. */
  root: string;
  links: ChainLink[];
}

function isNameChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

/**
 * Splits a receiver expression into the root it starts from and the members read off it.
 *
 * Only separators written at the top level count: the `->` inside `where($user->id)` is
 * part of an argument, not a step of the chain being read.
 */
export function splitChain(text: string): Chain {
  const trimmed = text.trim();
  const links: ChainLink[] = [];
  let depth = 0;
  let rootEnd = trimmed.length;
  let cursor = 0;

  while (cursor < trimmed.length) {
    const char = trimmed[cursor];

    if (char === "'" || char === '"') {
      const closing = closingQuote(trimmed, cursor);

      if (closing === null) {
        return { root: trimmed, links: [] };
      }

      cursor = closing + 1;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth++;
      cursor++;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth--;
      cursor++;
      continue;
    }

    const separator = separatorAt(trimmed, cursor);

    if (depth !== 0 || separator === 0) {
      cursor++;
      continue;
    }

    const nameStart = cursor + separator;
    let nameEnd = nameStart;

    while (nameEnd < trimmed.length && isNameChar(trimmed[nameEnd])) {
      nameEnd++;
    }

    if (nameEnd === nameStart) {
      // `$order->$field` names the member at runtime: the chain cannot be followed.
      return { root: trimmed, links: [] };
    }

    if (links.length === 0) {
      rootEnd = cursor;
    }

    links.push({ name: trimmed.slice(nameStart, nameEnd), isCall: trimmed[nameEnd] === '(' });
    cursor = nameEnd;
  }

  return { root: trimmed.slice(0, rootEnd).trim(), links };
}

/** Length of the separator written at `offset`, or 0 when there is none. */
function separatorAt(text: string, offset: number): number {
  if (text.startsWith('?->', offset)) {
    return 3;
  }

  if (text.startsWith('->', offset) || text.startsWith('::', offset)) {
    return 2;
  }

  return 0;
}

function closingQuote(text: string, openOffset: number): number | null {
  const quote = text[openOffset];

  for (let index = openOffset + 1; index < text.length; index++) {
    if (text[index] === '\\') {
      index++;
      continue;
    }

    if (text[index] === quote) {
      return index;
    }
  }

  return null;
}

/**
 * The class a declared type names, `?Customer` and `Customer|null` alike. A union answers
 * with every class it lists: any of them can be the one a call reaches.
 */
export function classNamesOf(written: string): string[] {
  return written
    .split(/[|&]/)
    .map((part) => part.trim().replace(/^\?/, ''))
    .filter((part) => part !== '' && !NON_CLASS_TYPES.has(part.toLowerCase()));
}

/** `Builder|null` still answers with the class the call was written on. */
export function isSelfType(written: string): boolean {
  return written
    .split(/[|&]/)
    .some((part) => SELF_TYPES.has(part.trim().replace(/^\?/, '').toLowerCase()));
}

/** What the project knows about its own types. Anything it does not declare is foreign. */
export interface TypeSource {
  /**
   * The type a member of `fqn` answers with, looked up through the hierarchy: the return
   * type for a call, the declared type for a property.
   */
  memberType(fqn: string, link: ChainLink): Resolution;
}

/**
 * Walks a chain from the type its root holds to the type its last link answers with.
 *
 * A single link that answers with something outside the project ends the walk: whatever
 * `->where(…)` returns, no member of ours is reached through it.
 */
export function followChain(root: Resolution, links: ChainLink[], source: TypeSource): Resolution {
  let current = root;

  for (const link of links) {
    if (current.kind !== 'type') {
      return current;
    }

    current = source.memberType(current.fqn, link);
  }

  return current;
}
