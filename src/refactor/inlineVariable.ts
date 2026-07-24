import { COMPOSITE_KINDS, type ExpressionNode } from '../php/expressions';
import { analyzeScopes, scopeAt, type FunctionScope, type Span, type VariableUse } from '../php/scopes';
import type { TextEdit } from './editSet';
import type { Plan, Planned } from './plan';
import { afterLine, lineStartOf } from './textLayout';

/** The variable the cursor is on, whatever the cursor sits on inside its name. */
export function variableAt(scope: FunctionScope, offset: number): VariableUse | null {
  return scope.uses.find((use) => use.start <= offset && use.end >= offset) ?? null;
}

function statementOf(scope: FunctionScope, offset: number): Span | null {
  return scope.blocks
    .flatMap((block) => block.statements)
    .filter((statement) => statement.start <= offset && statement.end >= offset)
    .sort((first, second) => first.end - first.start - (second.end - second.start))[0] ?? null;
}

/** The value of a plain `$name = …;` statement, or null when the statement does anything else. */
function assignedValue(text: string, statement: Span, name: string): Span | null {
  const code = text.slice(statement.start, statement.end);
  const head = new RegExp(`^\\$${name}\\s*=\\s*(?!=)`).exec(code);

  if (!head) {
    return null;
  }

  const start = statement.start + head[0].length;
  const end = text.lastIndexOf(';', statement.end) > start ? text.lastIndexOf(';', statement.end) : statement.end;

  return { start, end };
}

/**
 * Replaces a variable by the expression it was assigned, and drops the assignment.
 *
 * Only a variable written exactly once is inlined: with two assignments the value at each
 * use depends on the path taken, which no textual substitution can reproduce.
 */
export function planInlineVariable(text: string, offset: number): Planned<Plan> {
  const scopes = analyzeScopes(text);
  const scope = scopeAt(scopes, offset, offset);
  const target = scope ? variableAt(scope, offset) : null;

  if (!scope || !target || target.name === 'this') {
    return { error: 'Place the cursor on a local variable.' };
  }

  const mentions = scope.uses.filter((use) => use.name === target.name);
  const writes = mentions.filter((use) => use.isWrite);
  const reads = mentions.filter((use) => !use.isWrite);

  if (writes.length !== 1) {
    return { error: `$${target.name} is assigned ${writes.length} times and cannot be inlined.` };
  }

  if (scope.params.some((param) => param.name === target.name)) {
    return { error: `$${target.name} is a parameter, not a local variable.` };
  }

  const statement = statementOf(scope, writes[0].start);
  const value = statement ? assignedValue(text, statement, target.name) : null;

  if (!statement || !value) {
    return { error: `$${target.name} is not assigned by a plain statement.` };
  }

  if (reads.some((read) => read.start < writes[0].start)) {
    return { error: `$${target.name} is read before it is assigned.` };
  }

  const node = smallestAt(scopes.expressions, value);
  const code = text.slice(value.start, value.end).trim();
  const inlined = node && COMPOSITE_KINDS.has(node.kind) ? `(${code})` : code;

  const edits: TextEdit[] = reads.map((read) => ({ start: read.start, end: read.end, text: inlined }));
  edits.push({ start: lineStartOf(text, statement.start), end: afterLine(text, statement.end), text: '' });

  return {
    edits,
    summary: `Inlined $${target.name} into ${reads.length} use(s).`,
    warning:
      node?.hasEffect && reads.length > 1
        ? `$${target.name} holds the result of a call: inlining it runs that call ${reads.length} times.`
        : undefined,
  };
}

function smallestAt(expressions: ExpressionNode[], span: Span): ExpressionNode | null {
  return expressions
    .filter((expression) => expression.start >= span.start && expression.end <= span.end)
    .sort((first, second) => second.end - second.start - (first.end - first.start))[0] ?? null;
}
