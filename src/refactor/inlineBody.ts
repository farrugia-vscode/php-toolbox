/** Turning the body of a method into the code that replaces one of its calls. */
import type { MethodCall } from '../php/members';
import type { FunctionScope, Span } from '../php/scopes';
import type { InlineTarget } from './inlineMethod';

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

