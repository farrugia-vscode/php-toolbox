import { analyzeScopes, type FileScopes, type FunctionScope, type Span, type VariableUse } from '../php/scopes';
import { EditSet } from './editSet';
import type { Plan, Planned } from './plan';

/**
 * Offsets of the bare name inside a mention.
 *
 * A mention is written `$name`, but the parser reports the whole parameter for a parameter
 * (`int $count`) and keeps the `&` of a by-reference capture (`&$sum`), so the name is looked
 * up inside the span rather than derived from it. A span holding no `$name` at all is what
 * `"\${name}"` parses to — an escaped dollar is literal text, and renaming it would rewrite
 * the string.
 */
function nameRange(text: string, use: VariableUse): Span | null {
  const dollar = text.indexOf(`$${use.name}`, use.start);

  return dollar === -1 || dollar >= use.end ? null : { start: dollar + 1, end: dollar + 1 + use.name.length };
}

/**
 * Whether a nested function took the name from around it instead of declaring it.
 *
 * A closure names what it captures in `use (…)`, written before the body; an arrow function
 * captures every free variable without saying so.
 */
function capturesFromParent(scope: FunctionScope, name: string): boolean {
  if (scope.params.some((param) => param.name === name)) {
    return false;
  }

  return scope.kind === 'arrow' || scope.uses.some((use) => use.name === name && use.end <= scope.bodyStart);
}

/** The scope the variable belongs to, walking out for as long as the inner one only captured it. */
function owningScope(scopes: FileScopes, scope: FunctionScope, name: string): FunctionScope {
  if (scope.kind === 'file' || !capturesFromParent(scope, name)) {
    return scope;
  }

  const parent = scopes.functions
    .filter((candidate) => candidate !== scope && candidate.start <= scope.start && candidate.end >= scope.end)
    .sort((first, second) => first.end - first.start - (second.end - second.start))[0];

  return parent?.uses.some((use) => use.name === name) ? owningScope(scopes, parent, name) : scope;
}

/**
 * Every scope the variable is visible in: the one it lives in, plus the closures capturing it.
 *
 * An arrow function needs no entry of its own — its free variables are recorded where it is
 * written, so the scope around it already carries them.
 */
function scopesHolding(scopes: FileScopes, scope: FunctionScope, name: string): FunctionScope[] {
  const captured = scopes.functions.filter(
    (candidate) =>
      candidate.kind === 'closure' &&
      candidate !== scope &&
      candidate.start >= scope.bodyStart &&
      candidate.end <= scope.bodyEnd &&
      capturesFromParent(candidate, name),
  );

  return [scope, ...captured.flatMap((closure) => scopesHolding(scopes, closure, name))];
}

/** A local variable or parameter, with every scope a rename of it has to reach. */
export interface LocalTarget {
  name: string;
  scopes: FunctionScope[];
}

/**
 * The innermost function the offset falls in, signature included.
 *
 * `scopeAt` bounds a scope by its body, which is what an extraction needs; a parameter is
 * written before that body and would resolve to the file itself.
 */
function enclosingScope(scopes: FileScopes, offset: number): FunctionScope | null {
  return (
    scopes.functions
      .filter((scope) => scope.start <= offset && scope.end >= offset)
      .sort((first, second) => first.end - first.start - (second.end - second.start))[0] ?? null
  );
}

/** The variable the cursor is on, `$` included, or null when it is on anything else. */
export function localAt(scopes: FileScopes, text: string, offset: number): LocalTarget | null {
  const scope = enclosingScope(scopes, offset);

  if (!scope) {
    return null;
  }

  const mention = scope.uses.find((use) => {
    const range = nameRange(text, use);

    return range !== null && offset >= range.start - 1 && offset <= range.end;
  });

  if (!mention || mention.name === 'this') {
    return null;
  }

  const owner = owningScope(scopes, scope, mention.name);

  return { name: mention.name, scopes: scopesHolding(scopes, owner, mention.name) };
}

/** Names the rename would collide with, which is everything the same scopes already mention. */
export function namesTakenAround(target: LocalTarget): string[] {
  return [...new Set(target.scopes.flatMap((scope) => scope.uses.map((use) => use.name)))].filter(
    (name) => name !== target.name,
  );
}

/** Ways of naming a variable at runtime, which no rewrite of the source can follow. */
const NAMED_AT_RUNTIME = /\bcompact\s*\(|\bextract\s*\(|\$\$|\$\{/;

/**
 * Renames a local variable or a parameter everywhere its scope mentions it, following it into
 * the closures that capture it.
 *
 * A local is only ever visible inside the function that declares it, so this stays in one file
 * and needs no workspace pass — unlike a property, which the whole project may read.
 */
export function planRenameLocal(text: string, offset: number, newName: string): Planned<Plan> {
  const scopes = analyzeScopes(text);
  const target = localAt(scopes, text, offset);

  if (!target) {
    return { error: 'Place the cursor on a local variable or a parameter.' };
  }

  if (namesTakenAround(target).includes(newName)) {
    return { error: `$${newName} is already used here.` };
  }

  const edits = new EditSet();

  target.scopes.forEach((scope) =>
    scope.uses
      .filter((use) => use.name === target.name)
      .forEach((use) => {
        const range = nameRange(text, use);

        if (range) {
          edits.add({ start: range.start, end: range.end, text: newName });
        }
      }),
  );

  const collected = edits.all();
  const owner = target.scopes[0];

  return {
    edits: collected,
    summary: `Renamed $${target.name} to $${newName} — ${collected.length} mention(s).`,
    warning: NAMED_AT_RUNTIME.test(text.slice(owner.start, owner.end))
      ? `This scope names variables at runtime (compact, extract or $$name): mentions of $${target.name} made through a string are not renamed.`
      : undefined,
  };
}
