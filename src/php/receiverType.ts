/**
 * What a receiver expression was proven to hold.
 *
 * The three answers are not degrees of confidence, they are different facts: `type` names
 * the class reached, `foreign` says the class is one the project does not declare — so no
 * refactoring of ours can concern it — and `unknown` says nothing said what it holds.
 */
export type Resolution =
  | { kind: 'type'; fqn: string; arguments: string[] }
  /** A foreign class keeps its name and type arguments when they were written: `HasMany<Invoice>` still says what it holds. */
  | { kind: 'foreign'; fqn?: string; arguments?: string[] }
  | { kind: 'unknown' };

export const FOREIGN: Resolution = { kind: 'foreign' };
export const UNKNOWN: Resolution = { kind: 'unknown' };

export function typeResolution(fqn: string, typeArguments: string[] = []): Resolution {
  return { kind: 'type', fqn, arguments: typeArguments };
}

export function foreignResolution(fqn: string, typeArguments: string[] = []): Resolution {
  return { kind: 'foreign', fqn, arguments: typeArguments };
}

/** One member of a written type: `Builder<Customer>` is the name and what it is generic over. */
export interface WrittenType {
  name: string;
  arguments: string[];
}

/** Splits at the separator, leaving alone what sits between `<` and `>`. */
function splitTopLevel(text: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (char === '<') {
      depth++;
    } else if (char === '>') {
      depth--;
    } else if (depth === 0 && separators.includes(char)) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(text.slice(start));

  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** The members of a union or intersection type, each with its type arguments read apart. */
export function writtenTypesOf(written: string): WrittenType[] {
  return splitTopLevel(written, '|&').map((part) => {
    const bare = part.replace(/^\?/, '');
    const generic = /^([^<]+)<(.*)>$/.exec(bare);

    return generic
      ? { name: generic[1].trim(), arguments: splitTopLevel(generic[2], ',') }
      : { name: bare, arguments: [] };
  });
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
  return classTypesOf(written).map((type) => type.name);
}

/** The members of a written type that name a class, `Builder<Customer>|null` keeping only the builder. */
export function classTypesOf(written: string): WrittenType[] {
  return writtenTypesOf(written).filter((type) => !NON_CLASS_TYPES.has(type.name.toLowerCase()));
}

/** `Builder|null` still answers with the class the call was written on. */
export function isSelfType(written: string): boolean {
  return writtenTypesOf(written).some((type) => SELF_TYPES.has(type.name.toLowerCase()));
}

/** A type argument written as the class itself: `Builder<static>` is a builder of the class it is read on. */
export function isSelfArgument(written: string): boolean {
  return SELF_TYPES.has(written.replace(/^\?/, '').toLowerCase());
}

/** What the project knows about its own types, and what it is told about the others. */
export interface TypeSource {
  /**
   * The type a member of the owner answers with: looked up through the hierarchy for a
   * type of the project, asked of the registered extensions for a foreign one that kept
   * its name.
   */
  memberType(owner: Resolution, link: ChainLink): Resolution;
}

/**
 * Walks a chain from the type its root holds to the type its last link answers with.
 *
 * A link that answers with nothing known ends the walk: whatever `->where(…)` returns on a
 * class nobody named, no member of ours is reached through it.
 */
export function followChain(root: Resolution, links: ChainLink[], source: TypeSource): Resolution {
  let current = root;

  for (const link of links) {
    if (current.kind === 'unknown' || (current.kind === 'foreign' && current.fqn === undefined)) {
      return current;
    }

    current = source.memberType(current, link);
  }

  return current;
}
