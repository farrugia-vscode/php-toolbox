import type { Declaration, ParsedFile } from '../php/parser';
import type { MethodDeclaration, PropertyDeclaration } from '../php/members';

export type ConventionRule =
  | 'booleanPrefix'
  | 'actionVerb'
  | 'immutableService'
  | 'braces'
  | 'emDash';

/** What the quick fix does, when the rule knows how to fix itself. */
export type ConventionFix =
  | { kind: 'rename' }
  | { kind: 'edits'; edits: Array<{ start: number; end: number; text: string }> };

export interface ConventionIssue {
  rule: ConventionRule;
  message: string;
  /** Offsets of what the report underlines. */
  start: number;
  end: number;
  fix?: ConventionFix;
}

export interface ConventionOptions {
  /** Names `to*` is allowed to keep: a framework calls them and renaming breaks it. */
  contractMethods: string[];
}

export const DEFAULT_CONTRACT_METHODS = [
  'toArray',
  'toJson',
  'toString',
  'toMail',
  'toDatabase',
  'toBroadcast',
  'toResponse',
  'toSql',
  'authorize',
  'passes',
];

const BOOLEAN_PREFIXES = ['is', 'has', 'should', 'must', 'can', 'was', 'will'];

const TO_PREFIX = /^to[A-Z]/;

const PREFIX_LIST = BOOLEAN_PREFIXES.join(', ');

/** True when the name already announces a boolean, `isActive` and not `active`. */
function announcesBoolean(name: string): boolean {
  return BOOLEAN_PREFIXES.some(
    (prefix) =>
      name.startsWith(prefix) &&
      name.length > prefix.length &&
      name[prefix.length] === name[prefix.length].toUpperCase(),
  );
}

function isBoolean(type: string | null): boolean {
  return type !== null && type.replace('?', '').toLowerCase() === 'bool';
}

function isMagic(name: string): boolean {
  return name.startsWith('__');
}

/**
 * A boolean says what it is, never what it holds: `$active` reads as a state, `$isActive`
 * reads as an answer. The prefix is what makes the second the only way to read it.
 */
function booleanNames(parsed: ParsedFile, options: ConventionOptions): ConventionIssue[] {
  const issues: ConventionIssue[] = [];

  const report = (name: string, start: number, end: number, written: string) => {
    if (announcesBoolean(name)) {
      return;
    }

    issues.push({
      rule: 'booleanPrefix',
      message: `${written} is a boolean: prefix it with one of ${PREFIX_LIST}.`,
      start,
      end,
      fix: { kind: 'rename' },
    });
  };

  parsed.properties
    .filter((property: PropertyDeclaration) => isBoolean(property.type))
    .forEach((property) => report(property.name, property.nameStart, property.nameEnd, `$${property.name}`));

  // A promoted parameter declares a property, and the parser lists it as one.
  parsed.methods
    .filter(
      (method: MethodDeclaration) =>
        method.className.length > 0 &&
        isBoolean(method.returnType) &&
        !isMagic(method.name) &&
        !options.contractMethods.includes(method.name),
    )
    .forEach((method) => report(method.name, method.nameStart, method.nameEnd, `${method.name}()`));

  return issues;
}

/**
 * `toThumbnailPath` says where the value comes from, never what the function does with it.
 * A verb does, and which verb is the one question the file cannot answer alone.
 */
function actionVerbs(parsed: ParsedFile, options: ConventionOptions): ConventionIssue[] {
  return parsed.methods
    .filter(
      (method) =>
        method.className.length > 0 &&
        TO_PREFIX.test(method.name) &&
        !isMagic(method.name) &&
        !options.contractMethods.includes(method.name),
    )
    .map((method) => ({
      rule: 'actionVerb' as const,
      message: `${method.name}() starts with a preposition, not a verb: get${method.name.slice(2)}() by default, or the verb that says what it does.`,
      start: method.nameStart,
      end: method.nameEnd,
      fix: { kind: 'rename' as const },
    }));
}

/** Offset just after the parenthesis closing the one opened at `open`. */
function afterParens(text: string, open: number): number | null {
  let depth = 0;
  let quote: string | null = null;

  for (let index = open; index < text.length; index++) {
    const char = text[index];

    if (quote !== null) {
      if (char === '\\') {
        index++;
      } else if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

/** The `readonly` written on each property, which a readonly class forbids repeating. */
function redundantReadonly(text: string, parsed: ParsedFile, fqn: string) {
  const spans = parsed.properties
    .filter((property) => property.className === fqn)
    .map((property) => ({ start: property.start, end: property.end }))
    .concat(
      parsed.methods
        .filter((method) => method.className === fqn && method.name === '__construct')
        .flatMap((method) => method.params.map((param) => ({ start: param.start, end: param.end }))),
    );

  const removals = new Map<number, { start: number; end: number; text: string }>();

  spans.forEach(({ start, end }) => {
    const found = text.slice(start, end).match(/\breadonly\s+/);

    if (found?.index !== undefined) {
      const at = start + found.index;

      removals.set(at, { start: at, end: at + found[0].length, text: '' });
    }
  });

  return [...removals.values()];
}

/** True when nothing in the class stops PHP from making the whole of it readonly. */
function canBeReadonly(text: string, parsed: ParsedFile, declaration: Declaration): boolean {
  // A parent or a trait brings in properties this file never sees, and a single mutable
  // one turns `readonly class` from a convention into a fatal error.
  if (declaration.parent !== null || declaration.traits.length > 0) {
    return false;
  }

  // A readonly property may be neither static, untyped, nor given a default value.
  return parsed.properties
    .filter((property) => property.className === declaration.fqn)
    .every(
      (property) =>
        !property.isStatic &&
        property.type !== null &&
        !/=/.test(text.slice(property.start, property.end)),
    );
}

/**
 * A class built from what it is given has no reason to change afterwards, and saying so in
 * the declaration is what stops the question being asked of every method.
 */
function immutableServices(text: string, parsed: ParsedFile): ConventionIssue[] {
  return parsed.declarations.flatMap((declaration): ConventionIssue[] => {
    if (declaration.kind !== 'class' || declaration.isAbstract) {
      return [];
    }

    const constructor = parsed.methods.find(
      (method) => method.className === declaration.fqn && method.name === '__construct',
    );

    if (!constructor?.params.some((param) => param.isPromoted)) {
      return [];
    }

    const before = text.slice(0, declaration.start);
    const keyword = before.match(/\bclass\s+$/);

    if (keyword?.index === undefined) {
      return [];
    }

    // Only the modifiers of this declaration: anything before the previous statement,
    // brace or docblock belongs to something else.
    const own = before.slice(
      Math.max(
        before.lastIndexOf(';'),
        before.lastIndexOf('}'),
        before.lastIndexOf('{'),
        before.lastIndexOf('*/'),
        0,
      ),
      keyword.index,
    );

    const missing = [
      /\bfinal\b/.test(own) ? '' : 'final',
      /\breadonly\b/.test(own) || !canBeReadonly(text, parsed, declaration) ? '' : 'readonly',
    ].filter(Boolean);

    if (missing.length === 0) {
      return [];
    }

    const edits = [{ start: keyword.index, end: keyword.index, text: `${missing.join(' ')} ` }];

    return [
      {
        rule: 'immutableService',
        message: `${declaration.name} is built by injection: declare it ${missing.join(' ')}.`,
        start: declaration.start,
        end: declaration.end,
        fix: {
          kind: 'edits',
          edits: missing.includes('readonly')
            ? edits.concat(redundantReadonly(text, parsed, declaration.fqn))
            : edits,
        },
      },
    ];
  });
}

const CONDITION = /\b(if|elseif|for|foreach|while)\s*\(/g;
const BARE_ELSE = /\belse\b(?!\s*if\b)/g;

/**
 * A block written without braces reads as one line and behaves as one line, until a second
 * line is added under it. Only a body written on the line of its condition is reported: the
 * fix stays a wrap, with nothing to guess about where the block ends.
 */
function missingBraces(text: string): ConventionIssue[] {
  const issues: ConventionIssue[] = [];

  const wrap = (from: number) => {
    const line = text.slice(from, text.indexOf('\n', from) === -1 ? undefined : text.indexOf('\n', from));
    const body = line.match(/^[ \t]*(\S.*?;)[ \t]*$/);

    if (!body || body[1].startsWith('{')) {
      return;
    }

    const start = from + line.indexOf(body[1]);
    const end = start + body[1].length;
    const lineStart = text.lastIndexOf('\n', from) + 1;
    const indent = text.slice(lineStart).match(/^[ \t]*/)?.[0] ?? '';

    issues.push({
      rule: 'braces',
      message: 'A block always wears its braces, even for one statement.',
      start,
      end,
      fix: {
        kind: 'edits',
        edits: [{ start, end, text: `{\n${indent}    ${body[1]}\n${indent}}` }],
      },
    });
  };

  for (const match of text.matchAll(CONDITION)) {
    const after = afterParens(text, match.index + match[0].length - 1);

    if (after !== null) {
      wrap(after);
    }
  }

  for (const match of text.matchAll(BARE_ELSE)) {
    wrap(match.index + match[0].length);
  }

  return issues;
}

const EM_DASH = '—';

/** Offsets of every string literal, comments left out. */
function stringRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '/' && next === '/') {
      index = text.indexOf('\n', index);
    } else if (char === '#') {
      index = text.indexOf('\n', index);
    } else if (char === '/' && next === '*') {
      index = text.indexOf('*/', index);
    } else if (char === "'" || char === '"') {
      const start = index;

      for (index++; index < text.length; index++) {
        if (text[index] === '\\') {
          index++;
        } else if (text[index] === char) {
          break;
        }
      }

      ranges.push({ start: start + 1, end: index });
    }

    if (index === -1) {
      break;
    }
  }

  return ranges;
}

/**
 * An em dash in something a visitor reads is the one punctuation mark nobody types, which
 * is exactly what makes it read as generated. Comments keep theirs.
 */
function emDashes(text: string): ConventionIssue[] {
  return stringRanges(text).flatMap((range) => {
    const issues: ConventionIssue[] = [];

    for (let index = range.start; index < range.end; index++) {
      if (text[index] === EM_DASH) {
        issues.push({
          rule: 'emDash',
          message: 'An em dash reads as generated text: write a plain dash.',
          start: index,
          end: index + 1,
          fix: { kind: 'edits', edits: [{ start: index, end: index + 1, text: '-' }] },
        });
      }
    }

    return issues;
  });
}

/** Every place the file departs from the conventions, in the order they are written. */
export function conventionIssues(
  text: string,
  parsed: ParsedFile,
  options: ConventionOptions,
): ConventionIssue[] {
  return [
    ...booleanNames(parsed, options),
    ...actionVerbs(parsed, options),
    ...immutableServices(text, parsed),
    ...missingBraces(text),
    ...emDashes(text),
  ].sort((first, second) => first.start - second.start);
}
