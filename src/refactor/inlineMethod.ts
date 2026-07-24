import { COMPOSITE_KINDS } from '../php/expressions';
import { astOf } from '../php/nodeIndex';
import { bindings, isWholeValue, renamesFor, render, renderStatements, statementAround } from './inlineBody';
import type { MethodCall, MethodDeclaration } from '../php/members';
import { analyzeScopes, scopeAt, type FileScopes, type FunctionScope, type Span } from '../php/scopes';
import type { TextEdit } from './editSet';
import { afterLine, blankLineBefore, docblockStart, indentAt, indentUnit, lineStartOf } from './textLayout';

/** A method that can be replaced by its body, and the shape that body takes. */
export interface InlineTarget {
  method: MethodDeclaration;
  scope: FunctionScope;
  /** `expression` bodies are a single `return …;` and fit anywhere a call fits. */
  bodyKind: 'expression' | 'statements' | 'empty';
  /** The returned expression, for an `expression` body. */
  value: Span | null;
  /** Node kind of that expression, which says whether it survives without parentheses. */
  valueKind: string | null;
  statements: Span[];
  /** Early returns, which become the condition of what follows them once inlined. */
  guards: Guard[];
  text: string;
}

/** An `if (…) { return; }` standing between the caller and the rest of the body. */
export interface Guard {
  statement: Span;
  condition: Span;
}

/** A `$this` the inlined body keeps only works when the receiver is a plain variable. */
const PLAIN_RECEIVER = /^\$\w+$/;

function statementsOf(scope: FunctionScope, method: MethodDeclaration): Span[] {
  const body = scope.blocks.find((block) => block.start === (method.bodyStart ?? 0) - 1);

  return body?.statements ?? [];
}

/**
 * Whether a method is safe to inline, and how.
 *
 * The bar is deliberately high: without knowing the runtime type of every receiver, a
 * method that can be overridden or that returns from several places would be inlined wrong.
 */
export function inlineTarget(sourceText: string, method: MethodDeclaration, isFinalClass: boolean): InlineTarget | { error: string } {
  if (method.bodyStart === null || method.bodyEnd === null) {
    return { error: `${method.name}() has no body.` };
  }

  if (method.visibility === 'public' && !isFinalClass) {
    return {
      error: `${method.name}() is public and could be overridden: make it private, or the class final, before inlining it.`,
    };
  }

  if (method.params.some((param) => param.isByRef || param.isVariadic)) {
    return { error: `${method.name}() takes arguments by reference or a variadic, which cannot be inlined.` };
  }

  const scopes = analyzeScopes(sourceText);
  const scope = scopes.functions.find(
    (candidate) => candidate.kind === 'method' && candidate.bodyStart === method.bodyStart,
  );

  if (!scope) {
    return { error: `${method.name}() could not be analyzed.` };
  }

  if (scope.hasYield) {
    return { error: `${method.name}() is a generator.` };
  }

  const body = sourceText.slice(method.bodyStart, method.bodyEnd);

  if (new RegExp(`(?:\\$this|self|static|parent)\\s*(?:->|::)\\s*${method.name}\\s*\\(`).test(body)) {
    return { error: `${method.name}() calls itself.` };
  }

  if (/\bfunc_get_args\s*\(|\bstatic\s*::/.test(body)) {
    return { error: `${method.name}() depends on how it was called.` };
  }

  const statements = statementsOf(scope, method);
  const returns = scope.returns.filter(
    (statement) => statement.start >= method.bodyStart! && statement.end <= method.bodyEnd!,
  );
  const last = statements[statements.length - 1];

  const guards = guardsIn(sourceText, statements);
  const empty = { method, scope, value: null, valueKind: null, statements, guards, text: sourceText };

  if (returns.length === 0) {
    return { ...empty, bodyKind: statements.length === 0 ? 'empty' : 'statements' };
  }

  const guarded = returns.every((statement) =>
    guards.some((guard) => isInside(statement, guard.statement)),
  );

  // Guard clauses have no value to hand back: what follows them becomes conditional instead.
  if (guarded && method.returnType === 'void') {
    return { ...empty, bodyKind: 'statements' };
  }

  if (returns.length > 1 || !last || returns[0].start !== last.start) {
    return { error: `${method.name}() returns from more than one place.` };
  }

  if (statements.length > 1) {
    return { ...empty, bodyKind: 'statements' };
  }

  const value = valueOf(sourceText, last);

  if (!value) {
    return { error: `${method.name}() returns nothing usable.` };
  }

  const node = scopes.expressions
    .filter((expression) => expression.start >= value.start && expression.end <= value.end)
    .sort((first, second) => second.end - second.start - (first.end - first.start))[0];

  return { ...empty, bodyKind: 'expression', value, valueKind: node?.kind ?? null };
}

function isInside(span: Span, outer: Span): boolean {
  return span.start >= outer.start && span.end <= outer.end;
}

/** Statements of the shape `if (…) { return; }`, which an inline can turn inside out. */
function guardsIn(text: string, statements: Span[]): Guard[] {
  const ast = astOf(text);
  const guards: Guard[] = [];

  if (!ast) {
    return guards;
  }

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    const children = node.kind === 'if' ? node.body?.children ?? [] : [];
    const only = children.length === 1 ? children[0] : null;
    const isGuard =
      only?.kind === 'return' &&
      !only.expr &&
      !node.alternate &&
      statements.some((statement) => statement.start === node.loc.start.offset);

    if (isGuard) {
      guards.push({
        statement: { start: node.loc.start.offset, end: node.loc.end.offset },
        condition: { start: node.test.loc.start.offset, end: node.test.loc.end.offset },
      });
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

  return guards;
}

/** Offsets of the expression a `return …;` hands back. */
function valueOf(text: string, statement: Span): Span | null {
  const code = text.slice(statement.start, statement.end);
  const head = /^return\s+/.exec(code);

  if (!head) {
    return null;
  }

  const start = statement.start + head[0].length;
  const semicolon = text.lastIndexOf(';', statement.end);

  return { start, end: semicolon > start ? semicolon : statement.end };
}

/**
 * The edit that replaces one call by the body of the method it calls.
 *
 * A body made of several statements can only replace a call that is a statement of its own;
 * anywhere else there is no room for it, and the call is left alone.
 */
export function inlineCall(
  hostText: string,
  hostScopes: FileScopes,
  call: MethodCall,
  target: InlineTarget,
): TextEdit | { error: string } {
  const bound = bindings(call, target, hostText);

  if (!bound) {
    return { error: 'a call passes arguments this refactoring cannot map' };
  }

  const receiver = call.receiverKind === 'this' ? '$this' : call.receiverText;
  const usesThis = target.scope.usesThis;

  if (usesThis && call.receiverKind !== 'this' && !PLAIN_RECEIVER.test(receiver)) {
    return { error: 'a call is made on an expression the body would evaluate again' };
  }

  const host = scopeAt(hostScopes, call.start, call.end);

  if (!host) {
    return { error: 'a call sits outside any function' };
  }

  const statement = statementAround(host, call.start);

  if (target.bodyKind === 'expression' && target.value) {
    const code = render(target, target.value, bound, receiver, new Map());
    const isComposite = target.valueKind !== null && COMPOSITE_KINDS.has(target.valueKind);

    return {
      start: call.start,
      end: call.end,
      text: isComposite && !isWholeValue(hostText, call, statement) ? `(${code})` : code,
    };
  }

  // The parser hands the trailing semicolon to whichever node ends the statement, so both
  // sides are compared without it.
  const bare = (code: string): string => code.replace(/;\s*$/, '').trim();
  const isStatementCall =
    statement !== null && bare(hostText.slice(statement.start, statement.end)) === bare(hostText.slice(call.start, call.end));

  if (!statement || !isStatementCall) {
    return { error: 'a call uses the result of a method whose body is more than one expression' };
  }

  if (target.bodyKind === 'empty') {
    return { start: lineStartOf(hostText, statement.start), end: afterLine(hostText, statement.end), text: '' };
  }

  const renames = renamesFor(target, host);
  const indent = indentAt(hostText, statement.start);
  const body = renderStatements(
    target,
    bound,
    receiver,
    renames,
    indentAt(target.text, target.statements[0].start),
    indent,
    indentUnit(hostText),
  );

  return { start: lineStartOf(hostText, statement.start), end: statement.end, text: body };
}

/** Removes the method itself, docblock and all, once nothing calls it. */
export function removeMethod(sourceText: string, method: MethodDeclaration): TextEdit {
  const start = lineStartOf(sourceText, docblockStart(sourceText, method.start));

  return { start: blankLineBefore(sourceText, start), end: afterLine(sourceText, method.end), text: '' };
}
