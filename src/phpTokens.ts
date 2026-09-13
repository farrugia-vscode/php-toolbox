/** How a piece of a PHP line reads, for the colour the usages panel gives it. */
export type TokenKind = 'string' | 'variable' | 'keyword' | 'class' | 'function' | 'constant' | 'number' | 'comment' | 'plain';

export type Token = { kind: TokenKind; text: string };

const KEYWORDS = new Set([
  'new', 'function', 'fn', 'return', 'static', 'self', 'parent', 'instanceof', 'use', 'as', 'if', 'else', 'elseif',
  'foreach', 'for', 'while', 'match', 'throw', 'try', 'catch', 'finally', 'yield', 'clone', 'echo', 'print',
  'public', 'protected', 'private', 'readonly', 'abstract', 'final', 'class', 'interface', 'trait', 'enum',
  'extends', 'implements', 'const', 'null', 'true', 'false', 'array', 'string', 'int', 'float', 'bool', 'void',
  'mixed', 'callable', 'iterable', 'object', 'never', 'list', 'and', 'or', 'not',
]);

/** Words that name a class right after them: `new Order`, `instanceof Order`, `extends Order`. */
const CLASS_INTRODUCERS = new Set(['new', 'instanceof', 'extends', 'implements']);

// Strings first, since anything can sit inside one; an unterminated string runs to the end of a
// label cut short.
const PIECES = /'(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?|\$[A-Za-z_]\w*|\/\/.*|\/\*.*|\d+(?:\.\d+)?|[A-Za-z_\\][\w\\]*|\s+|[^\s\w$'"\/]+|\//g;

function kindOfWord(word: string, before: string, after: string): TokenKind {
  if (KEYWORDS.has(word.toLowerCase())) {
    return 'keyword';
  }

  const previous = before.trimEnd();
  const previousWord = previous.split(/\s+/).pop() ?? '';

  // `new Order(` names a class even though a parenthesis follows it.
  if (CLASS_INTRODUCERS.has(previousWord.toLowerCase())) {
    return 'class';
  }

  if (/^\s*\(/.test(after)) {
    return 'function';
  }

  if (after.startsWith('::')) {
    return 'class';
  }

  if (previous.endsWith('->')) {
    return 'variable';
  }

  if (/^[A-Z][A-Z0-9_]+$/.test(word)) {
    return 'constant';
  }

  if (/^\\?[A-Z]/.test(word)) {
    return 'class';
  }

  return 'plain';
}

function kindOf(piece: string, before: string, after: string): TokenKind {
  const first = piece[0];

  if (first === "'" || first === '"') {
    return 'string';
  }

  if (first === '$') {
    return 'variable';
  }

  if (piece.startsWith('//') || piece.startsWith('/*')) {
    return 'comment';
  }

  if (/^\d/.test(piece)) {
    return 'number';
  }

  if (/^[A-Za-z_\\]/.test(piece)) {
    return kindOfWord(piece, before, after);
  }

  return 'plain';
}

/**
 * Colours one line of PHP well enough to read it in a listing: strings, variables, calls,
 * classes and keywords stand out, and everything else stays plain. A grammar would do
 * better and cost far more; a line in a panel is skimmed, not edited.
 */
export function tokenizePhpLine(text: string): Token[] {
  const tokens: Token[] = [];

  for (const match of text.matchAll(PIECES)) {
    const piece = match[0];
    const start = match.index ?? 0;
    const kind = kindOf(piece, text.slice(0, start), text.slice(start + piece.length));
    const last = tokens[tokens.length - 1];

    if (last && last.kind === 'plain' && kind === 'plain') {
      last.text += piece;
      continue;
    }

    tokens.push({ kind, text: piece });
  }

  return tokens;
}
