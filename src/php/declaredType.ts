/** Reads the type a declaration announces, so the class behind it can be resolved in turn. */

export interface DeclaredType {
  name: string;
  /** Offset of the type name itself, in the text it was read from. */
  offset: number;
  /**
   * True for `$this`, `static` and `self`: they name no class to look up, they point back
   * at the class the declaration lives in.
   */
  isSelfType?: boolean;
}

/** Types answered by the declaring class itself — a fluent `@return $this` and its cousins. */
const SELF_TYPES = new Set(['$this', 'static', 'self']);

/** Types that name no class, so there is nothing to resolve behind them. */
const NON_CLASS_TYPES = new Set([
  'array', 'bool', 'callable', 'false', 'float', 'int', 'iterable', 'mixed', 'never',
  'null', 'object', 'parent', 'self', 'static', 'string', 'true', 'void',
]);

const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'var', 'final', 'const']);

const TYPE_PATTERN = /[?\\\w]+(?:\s*[|&]\s*[?\\\w]+)*/;

function lineBounds(text: string, offset: number): [number, number] {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const end = text.indexOf('\n', offset);

  return [start, end === -1 ? text.length : end];
}

/**
 * First class name of a type expression: `?Customer` and `Customer|null` both name
 * `Customer`, and the generic arguments of `BelongsTo<Customer>` are not part of the name.
 */
function firstClassName(expression: string): { name: string; index: number } | null {
  let cursor = 0;

  for (const part of expression.split(/[|&]/)) {
    const name = part.trim().replace(/^\?/, '').replace(/^\\/, '');
    const index = expression.indexOf(name, cursor);
    cursor = index + name.length;

    if (name !== '' && !NON_CLASS_TYPES.has(name.toLowerCase())) {
      return { name, index };
    }
  }

  return null;
}

function readType(expression: string, expressionOffset: number): DeclaredType | null {
  const first = expression.split(/[|&]/)[0].trim().replace(/^\?/, '');

  if (SELF_TYPES.has(first.toLowerCase())) {
    return { name: first, offset: expressionOffset + expression.indexOf(first), isSelfType: true };
  }

  const found = firstClassName(expression);

  return found ? { name: found.name, offset: expressionOffset + found.index } : null;
}

/** Offset of the `)` matching the `(` at `openOffset`, or null. */
function closingParen(text: string, openOffset: number): number | null {
  let depth = 0;

  for (let index = openOffset; index < text.length; index++) {
    const char = text[index];

    if (char === "'" || char === '"') {
      const closing = text.indexOf(char, index + 1);
      if (closing === -1) {
        return null;
      }
      index = closing;
      continue;
    }

    if (char === '(') {
      depth++;
      continue;
    }

    if (char === ')') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }

  return null;
}

/** `public function customer(): BelongsTo` — the type written after the parameter list. */
function returnType(text: string, offset: number): DeclaredType | null {
  const openParen = text.indexOf('(', offset);

  if (openParen === -1 || !/^\w+\s*$/.test(text.slice(offset, openParen))) {
    return null;
  }

  const closeParen = closingParen(text, openParen);

  if (closeParen === null) {
    return null;
  }

  const colon = /^\s*:\s*/.exec(text.slice(closeParen + 1));

  if (!colon) {
    return null;
  }

  const typeOffset = closeParen + 1 + colon[0].length;
  const expression = TYPE_PATTERN.exec(text.slice(typeOffset, typeOffset + 200));

  return expression ? readType(expression[0], typeOffset) : null;
}

/** `private ?Customer $customer;` — the type written just before the property name. */
function propertyType(line: string, lineOffset: number, column: number): DeclaredType | null {
  const expression = new RegExp(`(${TYPE_PATTERN.source})\\s+\\$?$`).exec(line.slice(0, column));

  if (!expression) {
    return null;
  }

  const found = readType(expression[1], lineOffset + expression.index);

  return found && !MODIFIERS.has(found.name.toLowerCase()) ? found : null;
}

/** `@property-read Customer $customer` and friends: types a class only declares in words. */
function annotatedType(line: string, lineOffset: number): DeclaredType | null {
  const annotation =
    /@(?:property(?:-read|-write)?|var)\s+(\S+)/.exec(line) ??
    /@method\s+(?:static\s+)?(\S+)\s+\w+\s*\(/.exec(line);

  if (!annotation) {
    return null;
  }

  return readType(annotation[1], lineOffset + line.indexOf(annotation[1], annotation.index));
}

/** A `@return`/`@var` written in the docblock the declaration hangs from. */
function docblockType(text: string, declarationStart: number, tag: RegExp): DeclaredType | null {
  let cursor = declarationStart - 1;

  for (let steps = 0; steps < 40 && cursor > 0; steps++) {
    const [lineStart, lineEnd] = lineBounds(text, cursor);
    const line = text.slice(lineStart, lineEnd);

    if (!/^\s*(?:\/\*\*|\*|#\[|$)/.test(line)) {
      return null;
    }

    const match = tag.exec(line);

    if (match) {
      return readType(match[1], lineStart + line.indexOf(match[1], match.index));
    }

    if (/^\s*\/\*\*/.test(line)) {
      return null;
    }

    cursor = lineStart - 1;
  }

  return null;
}

/**
 * The type declared by the member starting at `offset` — a method's return type, a
 * property's type, or the type of the annotation the member is declared by.
 */
export function findDeclaredType(text: string, offset: number): DeclaredType | null {
  const [lineStart, lineEnd] = lineBounds(text, offset);
  const line = text.slice(lineStart, lineEnd);

  if (/@(?:property(?:-read|-write)?|method|var)\b/.test(line)) {
    return annotatedType(line, lineStart);
  }

  if (/^\w+\s*\(/.test(text.slice(offset, offset + 200))) {
    return returnType(text, offset) ?? docblockType(text, lineStart, /@return\s+(\S+)/);
  }

  return (
    propertyType(line, lineStart, offset - lineStart) ??
    docblockType(text, lineStart, /@var\s+(\S+)/)
  );
}
