import { expressionAt, type ExpressionNode } from '../php/expressions';
import { parseFile } from '../php/parser';
import { analyzeScopes, scopeAt, type FunctionScope, type Span } from '../php/scopes';
import { classAt, memberIndent, memberInsertOffset, memberText } from './classEdits';
import type { TextEdit } from './editSet';
import type { Plan, Planned } from './plan';
import { indentAt, lineStartOf } from './textLayout';

export type ExtractTarget = 'variable' | 'constant' | 'property';

export interface ExtractExpressionPlan extends Plan {
  occurrences: number;
}

/** Selecting an expression by hand rarely lands exactly on it; the edges are whitespace. */
function trimmed(text: string, selection: Span): Span {
  let { start, end } = selection;

  while (start < end && /\s/.test(text[start])) {
    start++;
  }
  while (end > start && /\s/.test(text[end - 1])) {
    end--;
  }

  return { start, end };
}

/** The expression the cursor or the selection points at. */
export function targetExpression(
  text: string,
  selection: Span,
  expressions: ExpressionNode[],
): ExpressionNode | null {
  const span = trimmed(text, selection);

  if (span.end > span.start) {
    return expressionAt(expressions, span.start, span.end);
  }

  // On a bare cursor, the smallest expression around it is the useful one — but a lone
  // variable, or the assignment it belongs to, is nothing anyone means to extract.
  const around = expressions
    .filter((expression) => expression.start <= span.start && expression.end >= span.end)
    .filter((expression) => !UNEXTRACTABLE.has(expression.kind))
    .sort((first, second) => first.end - first.start - (second.end - second.start));

  return around[0] ?? null;
}

const UNEXTRACTABLE = new Set(['variable', 'name', 'assign', 'entry', 'list']);

/** Same code written the same way, whitespace apart. */
export function sameOccurrences(
  text: string,
  expressions: ExpressionNode[],
  target: ExpressionNode,
  bounds: Span,
): ExpressionNode[] {
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
  const wanted = normalize(text.slice(target.start, target.end));

  return expressions
    .filter((expression) => expression.start >= bounds.start && expression.end <= bounds.end)
    .filter((expression) => normalize(text.slice(expression.start, expression.end)) === wanted)
    .sort((first, second) => first.start - second.start)
    .filter((expression, index, all) => index === 0 || expression.start >= all[index - 1].end);
}

/** Statement the expression sits in, so the new line lands above it. */
function statementOf(scope: FunctionScope, offset: number): Span | null {
  return scope.blocks
    .flatMap((block) => block.statements)
    .filter((statement) => statement.start <= offset && statement.end >= offset)
    .sort((first, second) => first.end - first.start - (second.end - second.start))[0] ?? null;
}

/** A name built from the code itself, the way a reader would name it out loud. */
export function suggestName(code: string, target: ExtractTarget): string {
  const call = /(?:^|>|:)\s*(?:get|find|fetch|make|build|create)?([A-Za-z_]\w*)\s*\(/.exec(code);
  const property = /->\s*([A-Za-z_]\w*)\s*$/.exec(code.trim());
  const literal = /^['"]([A-Za-z_][\w \-]*)['"]$/.exec(code.trim());
  const raw = property?.[1] ?? call?.[1] ?? literal?.[1] ?? 'value';
  const camel = raw.replace(/[ \-]+(\w)/g, (_, letter: string) => letter.toUpperCase());

  if (target !== 'constant') {
    return camel.charAt(0).toLowerCase() + camel.slice(1);
  }

  return camel.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

const REFERENCE: Record<ExtractTarget, (name: string) => string> = {
  variable: (name) => `$${name}`,
  constant: (name) => `self::${name}`,
  property: (name) => `$this->${name}`,
};

/**
 * Pulls an expression out into a variable, a class constant or a property, replacing either
 * the one occurrence or every identical one in the same scope.
 */
export function planExtractExpression(
  text: string,
  selection: Span,
  name: string,
  target: ExtractTarget,
  { isReplacingAll = false }: { isReplacingAll?: boolean } = {},
): Planned<ExtractExpressionPlan> {
  const scopes = analyzeScopes(text);
  const expression = targetExpression(text, selection, scopes.expressions);

  if (!expression) {
    return { error: 'Select a complete expression.' };
  }

  const scope = scopeAt(scopes, expression.start, expression.end);

  if (!scope) {
    return { error: 'Select an expression inside a function or a method.' };
  }

  if (target === 'constant' && !expression.isConstant) {
    return { error: 'Only an expression made of literals can become a constant.' };
  }

  if (target !== 'variable' && scope.kind !== 'method') {
    return { error: `Select an expression inside a method to extract a ${target}.` };
  }

  const parsed = parseFile(text);
  const declaration = classAt(parsed, expression.start);

  if (target !== 'variable' && !declaration) {
    return { error: 'The expression is not inside a class.' };
  }

  // `self::` and `$this->` only mean anything inside the class, so a class member replaces
  // its occurrences class-wide while a variable stays in its own scope.
  const bounds =
    target === 'variable' || !declaration
      ? { start: scope.bodyStart, end: scope.bodyEnd }
      : { start: declaration.bodyStart, end: declaration.bodyEnd };
  const occurrences = isReplacingAll
    ? sameOccurrences(text, scopes.expressions, expression, bounds)
    : [expression];
  const statement = statementOf(scope, occurrences[0].start);

  if (!statement) {
    return { error: 'Select an expression inside a statement.' };
  }

  const code = text.slice(expression.start, expression.end);
  const reference = REFERENCE[target](name);
  const edits: TextEdit[] = occurrences.map((occurrence) => ({
    start: occurrence.start,
    end: occurrence.end,
    text: reference,
  }));

  if (target === 'variable') {
    const indent = indentAt(text, statement.start);
    const anchor = lineStartOf(text, statement.start);

    edits.push({ start: anchor, end: anchor, text: `${indent}$${name} = ${code};\n` });

    return { edits, occurrences: occurrences.length, summary: summaryOf(name, occurrences.length) };
  }

  if (!declaration) {
    return { error: 'The expression is not inside a class.' };
  }

  const kind = target === 'constant' ? 'constant' : 'property';
  const anchor = memberInsertOffset(text, parsed, declaration, kind);
  const indent = memberIndent(text, parsed, declaration);
  const isConstantValue = expression.isConstant;
  const member =
    target === 'constant'
      ? `private const ${name} = ${code};`
      : `private $${name}${isConstantValue ? ` = ${code}` : ''};`;

  edits.push({ start: anchor.offset, end: anchor.offset, text: memberText(member, indent, anchor) });

  // A property whose value is computed has to be filled in where the code used to compute it.
  if (target === 'property' && !isConstantValue) {
    const statementIndent = indentAt(text, statement.start);
    const lineStart = lineStartOf(text, statement.start);

    edits.push({ start: lineStart, end: lineStart, text: `${statementIndent}$this->${name} = ${code};\n` });
  }

  return { edits, occurrences: occurrences.length, summary: summaryOf(name, occurrences.length) };
}

function summaryOf(name: string, count: number): string {
  return count > 1 ? `Extracted ${name} — ${count} occurrences replaced.` : `Extracted ${name}.`;
}
