import type { Intention } from '.';
import { textOf } from './nodeText';

/**
 * The three ways to write the same string — concatenation, interpolation, `sprintf` —
 * converted into one another, so the choice is made on how it reads rather than on how
 * tedious it is to rewrite.
 */

/** Only what reads the same inside double quotes: no escapes, no expressions. */
const PLAIN_LITERAL = /^'[^'"$\\{]*'$/;
const INTERPOLABLE = new Set(['variable', 'propertylookup', 'offsetlookup']);

/** The `.` chain the cursor sits in, as a flat list of operands. */
function concatOperands(chain: any[]): any[] | null {
  // `a . b . c` nests to the left, so the whole chain is the outermost of them.
  const node = [...chain].reverse().find((candidate) => candidate.kind === 'bin' && candidate.type === '.');

  if (!node) {
    return null;
  }

  const operands: any[] = [];
  const flatten = (current: any): void => {
    if (current.kind === 'bin' && current.type === '.') {
      flatten(current.left);
      flatten(current.right);
      return;
    }

    operands.push(current);
  };
  flatten(node);

  return operands;
}

function concatNode(chain: any[]): any | null {
  return [...chain].reverse().find((candidate) => candidate.kind === 'bin' && candidate.type === '.') ?? null;
}

/** A double-quoted string carrying expressions, which the parser reads as `encapsed`. */
function encapsedNode(chain: any[]): any | null {
  return chain.find((candidate) => candidate.kind === 'encapsed' && candidate.type === 'string') ?? null;
}

function isLiteral(node: any): boolean {
  return node.kind === 'string';
}

/** What sits between the quotes, exactly as it was written. */
function rawContent(text: string, node: any): string {
  return textOf(text, node).trim().slice(1, -1);
}

function quoteOf(text: string, node: any): string {
  return textOf(text, node).trim().charAt(0);
}

/** A literal placed in a format string: every `%` in it stands for itself. */
function escapePercent(content: string): string {
  return content.replace(/%/g, '%%');
}

function sprintfCall(format: string, args: string[]): string {
  return `sprintf(${[format, ...args].join(', ')})`;
}

function interpolated(text: string, node: any): string | null {
  const written = textOf(text, node);

  if (node.kind === 'string' && PLAIN_LITERAL.test(written.trim())) {
    return written.trim().slice(1, -1);
  }

  if (INTERPOLABLE.has(node.kind) && /^\$[\w>\-\[\]'"]+$/.test(written.trim())) {
    return `{${written.trim()}}`;
  }

  return null;
}

/** `'Hello ' . $name . '!'` says less than `"Hello {$name}!"`. */
export function concatToInterpolation(text: string, chain: any[]): Intention | null {
  const node = concatNode(chain);
  const operands = concatOperands(chain);

  if (!node || !operands) {
    return null;
  }

  const parts = operands.map((operand) => interpolated(text, operand));

  if (parts.some((part) => part === null) || operands.every(isLiteral)) {
    return null;
  }

  return {
    title: 'Convert to string interpolation',
    edits: [{ start: node.loc.start.offset, end: node.loc.end.offset, text: `"${parts.join('')}"` }],
  };
}

/**
 * `sprintf` is the one form that takes any expression, so a chain holding a call — which
 * neither interpolation nor a readable concatenation handles — still has somewhere to go.
 */
export function concatToSprintf(text: string, chain: any[]): Intention | null {
  const node = concatNode(chain);
  const operands = concatOperands(chain);

  if (!node || !operands || operands.every(isLiteral)) {
    return null;
  }

  const literals = operands.filter(isLiteral);
  const quotes = new Set(literals.map((literal) => quoteOf(text, literal)));

  // Mixed quoting would need the escapes of one style rewritten into the other.
  if (quotes.size > 1) {
    return null;
  }

  const quote = [...quotes][0] ?? "'";
  const format = operands
    .map((operand) => (isLiteral(operand) ? escapePercent(rawContent(text, operand)) : '%s'))
    .join('');
  const args = operands.filter((operand) => !isLiteral(operand)).map((operand) => textOf(text, operand));

  return {
    title: 'Convert to sprintf',
    edits: [
      {
        start: node.loc.start.offset,
        end: node.loc.end.offset,
        text: sprintfCall(`${quote}${format}${quote}`, args),
      },
    ],
  };
}

interface EncapsedParts {
  /** Literal chunks and expressions, in the order they appear. */
  pieces: Array<{ isLiteral: boolean; text: string }>;
  hasExpression: boolean;
  hasLiteral: boolean;
  /** `\n` means a newline here and a backslash in a single-quoted string. */
  hasEscape: boolean;
}

/** Splits an interpolated string into its literal chunks and its expressions. */
function encapsedParts(text: string, node: any): EncapsedParts | null {
  const pieces: EncapsedParts['pieces'] = [];

  for (const part of node.value ?? []) {
    const expression = part.kind === 'encapsedpart' ? part.expression : part;

    if (expression.kind === 'string') {
      pieces.push({ isLiteral: true, text: expression.raw });
      continue;
    }

    if (!expression.loc) {
      return null;
    }

    pieces.push({ isLiteral: false, text: textOf(text, expression) });
  }

  return {
    pieces,
    hasExpression: pieces.some((piece) => !piece.isLiteral),
    hasLiteral: pieces.some((piece) => piece.isLiteral),
    hasEscape: pieces.some((piece) => piece.isLiteral && piece.text.includes('\\')),
  };
}

/** `"Hello {$name}!"` back to `'Hello ' . $name . '!'`, for a part that grew too dense. */
export function interpolationToConcat(text: string, chain: any[]): Intention | null {
  const node = encapsedNode(chain);
  const parts = node ? encapsedParts(text, node) : null;

  // Without a literal chunk the quotes are the only thing making the result a string:
  // `"$count"` is text where `$count` is a number. An escape rules it out too, since
  // single quotes would take it literally.
  if (!node || !parts || !parts.hasExpression || !parts.hasLiteral || parts.hasEscape) {
    return null;
  }

  const written = parts.pieces
    .map((piece) => (piece.isLiteral ? `'${piece.text.replace(/'/g, "\\'")}'` : piece.text))
    .join(' . ');

  return {
    title: 'Convert to concatenation',
    edits: [{ start: node.loc.start.offset, end: node.loc.end.offset, text: written }],
  };
}

/** `"Hello {$name}!"` as `sprintf('Hello %s!', $name)`. */
export function interpolationToSprintf(text: string, chain: any[]): Intention | null {
  const node = encapsedNode(chain);
  const parts = node ? encapsedParts(text, node) : null;

  if (!node || !parts || !parts.hasExpression) {
    return null;
  }

  const format = parts.pieces
    .map((piece) => (piece.isLiteral ? escapePercent(piece.text) : '%s'))
    .join('');
  const args = parts.pieces.filter((piece) => !piece.isLiteral).map((piece) => piece.text);

  // An escape only keeps its meaning inside double quotes, so the format string stays
  // written the way it already was.
  const quoted = parts.hasEscape ? `"${format}"` : `'${format.replace(/'/g, "\\'")}'`;

  return {
    title: 'Convert to sprintf',
    edits: [{ start: node.loc.start.offset, end: node.loc.end.offset, text: sprintfCall(quoted, args) }],
  };
}
