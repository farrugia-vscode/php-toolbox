/** Turning the body of a method into the code that replaces one of its calls. */
import type { MethodCall } from '../php/members';
import { nodeChain } from '../php/nodeIndex';
import type { FunctionScope, Span } from '../php/scopes';
import type { InlineTarget } from './inlineMethod';
import { reindent } from './textLayout';

/** What each parameter stands for at one call site, arguments and defaults together. */
export function bindings(call: MethodCall, target: InlineTarget, hostText: string): Map<string, string> | null {
  const bound = new Map<string, string>();

  if (call.hasSpread) {
    return null;
  }

  const positional = call.args.filter((argument) => argument.label === null);
  const named = new Map(call.args.filter((argument) => argument.label !== null).map((argument) => [argument.label!, argument]));

  for (const [index, param] of target.method.params.entries()) {
    const argument = named.get(param.name) ?? positional[index];
    const code = argument ? hostText.slice(argument.start, argument.end).trim() : param.defaultText;

    if (code === null) {
      return null;
    }

    bound.set(param.name, code);
  }

  return bound;
}

/** Rewrites a slice of the method body, substituting parameters and `$this`. */
export function render(target: InlineTarget, span: Span, bound: Map<string, string>, receiver: string, renames: Map<string, string>): string {
  const uses = target.scope.uses
    .filter((use) => use.start >= span.start && use.end <= span.end)
    .sort((first, second) => second.start - first.start);

  let code = target.text.slice(span.start, span.end);

  uses.forEach((use) => {
    const replacement =
      use.name === 'this' ? receiver : bound.get(use.name) ?? (renames.has(use.name) ? `$${renames.get(use.name)}` : null);

    if (replacement === null || replacement === undefined) {
      return;
    }

    const start = use.start - span.start;
    const end = use.end - span.start;

    code = code.slice(0, start) + replacement + code.slice(end);
  });

  return code;
}

/** Local names the body would shadow at the call site, renamed rather than refused. */
export function renamesFor(target: InlineTarget, host: FunctionScope): Map<string, string> {
  const parameters = new Set(target.method.params.map((param) => param.name));
  const taken = new Set(host.uses.map((use) => use.name));
  const renames = new Map<string, string>();

  target.scope.uses
    .filter((use) => use.name !== 'this' && !parameters.has(use.name) && taken.has(use.name))
    .forEach((use) => {
      if (renames.has(use.name)) {
        return;
      }

      let candidate = `${use.name}Inlined`;
      let suffix = 2;

      while (taken.has(candidate)) {
        candidate = `${use.name}Inlined${suffix++}`;
      }

      taken.add(candidate);
      renames.set(use.name, candidate);
    });

  return renames;
}

/** Whether the call is the whole value of its statement, where parentheses add nothing. */
export function isWholeValue(hostText: string, call: MethodCall, statement: Span | null): boolean {
  if (!statement) {
    return false;
  }

  const before = hostText.slice(statement.start, call.start).trim();
  const after = hostText.slice(call.end, statement.end).replace(/;\s*$/, '').trim();

  return after === '' && (before === '' || before === 'return' || before.endsWith('='));
}

export function statementAround(scope: FunctionScope, offset: number): Span | null {
  return scope.blocks
    .flatMap((block) => block.statements)
    .filter((statement) => statement.start <= offset && statement.end >= offset)
    .sort((first, second) => first.end - first.start - (second.end - second.start))[0] ?? null;
}


/** The condition of a guard, negated and with the call's arguments already substituted. */
function negatedCondition(
  target: InlineTarget,
  condition: Span,
  bound: Map<string, string>,
  receiver: string,
  renames: Map<string, string>,
): string {
  const node = nodeChain(target.text, condition.start).find(
    (candidate) => candidate.loc.start.offset === condition.start && candidate.loc.end.offset === condition.end,
  );
  const rendered = (span: { loc: { start: { offset: number }; end: { offset: number } } }): string =>
    render(target, { start: span.loc.start.offset, end: span.loc.end.offset }, bound, receiver, renames).trim();

  if (node?.kind === 'unary' && node.type === '!') {
    return rendered(node.what);
  }

  if (node?.kind === 'bin' && OPPOSITE[node.type]) {
    return `${rendered(node.left)} ${OPPOSITE[node.type]} ${rendered(node.right)}`;
  }

  const whole = render(target, condition, bound, receiver, renames).trim();

  if (node && SIMPLE_CONDITION.has(node.kind)) {
    return `!${whole}`;
  }

  return `!(${whole})`;
}

const OPPOSITE: Record<string, string> = {
  '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>',
};

const SIMPLE_CONDITION = new Set(['variable', 'call', 'propertylookup', 'nullsafepropertylookup', 'staticlookup']);

/**
 * The body as it reads at the call site.
 *
 * An early `return` cannot survive the move — it would return from the caller — so what
 * follows a guard becomes the body of the negated guard instead.
 */
export function renderStatements(
  target: InlineTarget,
  bound: Map<string, string>,
  receiver: string,
  renames: Map<string, string>,
  sourceIndent: string,
  targetIndent: string,
  unit: string,
): string {
  const build = (list: Span[], level: number): string[] => {
    const indent = `${targetIndent}${unit.repeat(level)}`;
    const guardIndex = list.findIndex((statement) =>
      target.guards.some((guard) => guard.statement.start === statement.start),
    );

    if (guardIndex === -1) {
      return list.length === 0
        ? []
        : [reindent(render(target, { start: list[0].start, end: list[list.length - 1].end }, bound, receiver, renames), sourceIndent, indent)];
    }

    const guard = target.guards.find((candidate) => candidate.statement.start === list[guardIndex].start)!;
    const before = build(list.slice(0, guardIndex), level);
    const rest = list.slice(guardIndex + 1);

    // Nothing follows the guard, so there is nothing left for it to protect.
    if (rest.length === 0) {
      return before;
    }

    return [
      ...before,
      `${indent}if (${negatedCondition(target, guard.condition, bound, receiver, renames)}) {`,
      ...build(rest, level + 1),
      `${indent}}`,
    ];
  };

  return build(target.statements, 0).join('\n');
}
