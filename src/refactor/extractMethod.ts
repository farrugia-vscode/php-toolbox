import { analyzeScopes, scopeAt, type Block, type FunctionScope, type Span } from '../php/scopes';
import type { TextEdit } from './editSet';
import type { Plan, Planned } from './plan';
import { indentAt, indentUnit, reindent } from './textLayout';

export interface ExtractMethodPlan extends Plan {
  parameters: string[];
  returned: string[];
}

/** Written by the runtime, not by the surrounding code: passing them along would be noise. */
const SUPERGLOBALS = new Set([
  'this', 'GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION', '_REQUEST', '_ENV',
  'argv', 'argc', 'http_response_header',
]);

/** The smallest block the whole selection fits in — the one an extraction can cut out of. */
function enclosingBlock(scope: FunctionScope, selection: Span): Block | null {
  return scope.blocks
    .filter((block) => block.start <= selection.start && block.end >= selection.end)
    .sort((first, second) => first.end - first.start - (second.end - second.start))[0] ?? null;
}

/** Grows the selection to the statements it touches: half a statement cannot be moved. */
function statementSpan(block: Block, selection: Span): Span | null {
  const touched = block.statements.filter(
    (statement) => statement.end > selection.start && statement.start < selection.end,
  );

  if (touched.length === 0) {
    return null;
  }

  return { start: touched[0].start, end: touched[touched.length - 1].end };
}

function isInside(span: Span, outer: Span): boolean {
  return span.start >= outer.start && span.end <= outer.end;
}

/**
 * Control flow that would not survive the move. A `return` is fine only when the selection
 * runs to the end of the method, because the call can then return in its place.
 */
function flowRefusal(scope: FunctionScope, block: Block, span: Span): string | null {
  if (scope.hasYield && scope.returns.some((statement) => isInside(statement, span))) {
    return 'A generator cannot have its yields extracted.';
  }

  const jumps = scope.jumps.filter((jump) => isInside(jump, span));
  const isJumpContained = jumps.every((jump) =>
    scope.loops.some((loop) => isInside(loop, span) && isInside(jump, loop)),
  );

  if (!isJumpContained) {
    return 'The selection breaks out of a loop that stays behind.';
  }

  const returns = scope.returns.filter((statement) => isInside(statement, span));

  if (returns.length === 0) {
    return null;
  }

  const isTail = block.start === scope.bodyStart - 1 && span.end === block.statements[block.statements.length - 1]?.end;

  return isTail ? null : 'The selection returns from the middle of the method.';
}

interface Variables {
  parameters: string[];
  returned: string[];
}

/**
 * Variables read before they are written inside the selection become parameters, and those
 * the selection writes and the rest of the method still reads have to come back out.
 */
function classifyVariables(scope: FunctionScope, span: Span): Variables {
  const inside = scope.uses.filter((use) => isInside(use, span));
  const before = scope.uses.filter((use) => use.end <= span.start);
  const after = scope.uses.filter((use) => use.start >= span.end);
  const parameters: string[] = [];
  const returned: string[] = [];

  inside.forEach((use) => {
    if (SUPERGLOBALS.has(use.name)) {
      return;
    }

    const isFirstMention = inside.find((candidate) => candidate.name === use.name) === use;

    if (isFirstMention && !use.isWrite && !parameters.includes(use.name)) {
      parameters.push(use.name);
    }

    const isReadAfter = after.some((later) => later.name === use.name && !later.isWrite);

    if (use.isWrite && isReadAfter && !returned.includes(use.name)) {
      returned.push(use.name);
    }
  });

  // A parameter that is never set before the selection would arrive as null either way,
  // so it is only worth passing when the method already knows it.
  const known = new Set([...before.map((use) => use.name), ...scope.params.map((param) => param.name)]);

  return { parameters: parameters.filter((name) => known.has(name)), returned };
}

function signatureOf(scope: FunctionScope, name: string, variables: Variables, returnsFlow: boolean): string {
  const typed = variables.parameters.map((parameter) => {
    const declared = scope.params.find((param) => param.name === parameter);
    const type = declared?.type;

    return type ? `${type} $${parameter}` : `$${parameter}`;
  });

  const returnType = returnsFlow
    ? scope.returnType
    : variables.returned.length > 1
      ? 'array'
      : variables.returned.length === 1
        ? null
        : 'void';

  const modifiers = `private${scope.isStatic ? ' static' : ''}`;

  return `${modifiers} function ${name}(${typed.join(', ')})${returnType ? `: ${returnType}` : ''}`;
}

function callOf(scope: FunctionScope, name: string, variables: Variables, returnsFlow: boolean): string {
  const receiver = scope.isStatic ? 'self::' : '$this->';
  const call = `${receiver}${name}(${variables.parameters.map((parameter) => `$${parameter}`).join(', ')});`;

  if (returnsFlow) {
    return `return ${call}`;
  }

  if (variables.returned.length === 1) {
    return `$${variables.returned[0]} = ${call}`;
  }

  if (variables.returned.length > 1) {
    return `[${variables.returned.map((name) => `$${name}`).join(', ')}] = ${call}`;
  }

  return call;
}

/**
 * Turns a run of statements into a method of its own, called where they used to be.
 *
 * The selection is grown to whole statements first, the way an editor does it: people
 * select roughly, and refusing on a missing semicolon helps nobody.
 */
export function planExtractMethod(text: string, selection: Span, name: string): Planned<ExtractMethodPlan> {
  const scopes = analyzeScopes(text);
  const scope = scopeAt(scopes, selection.start, selection.end);

  if (!scope || scope.kind !== 'method') {
    return { error: 'Select statements inside a method body.' };
  }

  const isTaken = scopes.functions.some(
    (candidate) =>
      candidate.kind === 'method' && candidate.className === scope.className && candidate.name === name,
  );

  if (isTaken) {
    return { error: `${scope.className.split('\\').pop()} already has a method named ${name}.` };
  }

  const block = enclosingBlock(scope, selection);
  const span = block ? statementSpan(block, selection) : null;

  if (!block || !span) {
    return { error: 'Select one or more complete statements.' };
  }

  const refusal = flowRefusal(scope, block, span);

  if (refusal) {
    return { error: refusal };
  }

  const variables = classifyVariables(scope, span);
  const returnsFlow = scope.returns.some((statement) => isInside(statement, span));

  if (returnsFlow && variables.returned.length > 0) {
    return { error: 'The selection both returns and leaves variables behind.' };
  }

  const unit = indentUnit(text);
  const methodIndent = indentAt(text, scope.start);
  const bodyIndent = `${methodIndent}${unit}`;
  const selected = text.slice(span.start, span.end);
  const moved = reindent(selected, indentAt(text, span.start), bodyIndent);
  const tail =
    variables.returned.length === 1
      ? `\n${bodyIndent}return $${variables.returned[0]};`
      : variables.returned.length > 1
        ? `\n${bodyIndent}return [${variables.returned.map((name) => `$${name}`).join(', ')}];`
        : '';

  const method = [
    '',
    '',
    `${methodIndent}${signatureOf(scope, name, variables, returnsFlow)}`,
    `${methodIndent}{`,
    `${moved}${tail}`,
    `${methodIndent}}`,
  ].join('\n');

  const edits: TextEdit[] = [
    { start: span.start, end: span.end, text: callOf(scope, name, variables, returnsFlow) },
    { start: scope.end, end: scope.end, text: method },
  ];

  return {
    edits,
    parameters: variables.parameters,
    returned: variables.returned,
    summary: `Extracted ${name}(${variables.parameters.map((parameter) => `$${parameter}`).join(', ')}).`,
  };
}
