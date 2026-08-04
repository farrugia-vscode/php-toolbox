import type { Intention } from '.';
import { astOf } from '../php/nodeIndex';
import { textOf } from './nodeText';

/** Written by PHP itself: never something the closure has to capture. */
const SUPERGLOBALS = new Set([
  'GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION', '_REQUEST', '_ENV',
]);

function closureNode(chain: any[]): any | null {
  return chain.find((candidate) => candidate.kind === 'closure') ?? null;
}

function walk(node: any, visit: (node: any) => boolean | void): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit));
    return;
  }

  if (visit(node) === false) {
    return;
  }

  Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key], visit));
}

/** Variable names the subtree assigns to: those belong to the closure, not to its caller. */
function assignedNames(node: any): Set<string> {
  const names = new Set<string>();

  walk(node, (current) => {
    if (current.kind === 'assign' && current.left?.kind === 'variable') {
      names.add(current.left.name);
    }

    if (current.kind === 'foreach') {
      [current.key, current.value].forEach((target) => {
        if (target?.kind === 'variable') {
          names.add(target.name);
        }
      });
    }
  });

  return names;
}

function readNames(node: any): string[] {
  const names: string[] = [];

  walk(node, (current) => {
    if (current.kind === 'variable' && typeof current.name === 'string') {
      names.push(current.name);
    }
  });

  return names;
}

/**
 * True when the file has that variable outside the closure, which is where it would be
 * captured from. A parameter counts: it is declared as a name, not as a variable node.
 */
function existsOutside(ast: any, name: string, closure: any): boolean {
  let found = false;

  walk(ast, (current) => {
    if (current === closure) {
      // Skip the closure itself: a name only used inside it comes from nowhere.
      return false;
    }

    const isSameVariable = current.kind === 'variable' && current.name === name;
    const isSameParameter = current.kind === 'parameter' && current.name?.name === name;

    if (isSameVariable || isSameParameter) {
      found = true;
    }
  });

  return found;
}

/** The outer variables the closure reads without declaring them anywhere. */
function freeVariables(ast: any, closure: any): string[] {
  const declared = new Set<string>([
    'this',
    ...(closure.arguments ?? []).map((argument: any) => argument?.name?.name).filter(Boolean),
    ...(closure.uses ?? []).map((used: any) => used?.name).filter(Boolean),
    ...assignedNames(closure.body),
  ]);

  return [
    ...new Set(
      readNames(closure.body).filter(
        (name) => !declared.has(name) && !SUPERGLOBALS.has(name) && existsOutside(ast, name, closure),
      ),
    ),
  ];
}

/** Where `use (…)` has to be written: right after the parameter list. */
function useClauseEdit(text: string, closure: any, names: string[]): Intention['edits'] {
  const added = names.map((name) => `$${name}`);
  const existing = closure.uses ?? [];

  if (existing.length > 0) {
    const last = existing[existing.length - 1];

    return [{ start: last.loc.end.offset, end: last.loc.end.offset, text: `, ${added.join(', ')}` }];
  }

  const bodyStart = closure.body.loc.start.offset;
  const closingParen = text.lastIndexOf(')', bodyStart);

  return [{ start: closingParen + 1, end: closingParen + 1, text: ` use (${added.join(', ')})` }];
}

/**
 * A closure sees nothing of the scope holding it, so a variable read inside it and never
 * declared there is a fatal error waiting for the line to run. `use (…)` is the only fix
 * that keeps a multi-statement body: an arrow function captures on its own, but it can
 * only ever be one expression, and its result becomes the return value.
 */
export function captureInClosure(text: string, chain: any[]): Intention | null {
  const closure = closureNode(chain);
  const ast = astOf(text);

  if (!closure?.body || !ast) {
    return null;
  }

  const free = freeVariables(ast, closure);

  if (free.length === 0) {
    return null;
  }

  const written = free.map((name) => `$${name}`).join(', ');

  return {
    title: `Capture ${written} in the closure`,
    edits: useClauseEdit(text, closure, free),
  };
}

/** A closure whose whole body is a `return` is an arrow function waiting to happen. */
export function closureToArrow(text: string, chain: any[]): Intention | null {
  const node = closureNode(chain);
  const statements = node?.body?.children ?? [];
  const returned = statements.length === 1 && statements[0].kind === 'return' ? statements[0].expr : null;

  if (!node || !returned || (node.uses ?? []).some((used: any) => used.byref)) {
    return null;
  }

  const params = (node.arguments ?? []).map((argument: any) => textOf(text, argument)).join(', ');
  const modifier = node.isStatic ? 'static ' : '';
  const returnType = node.type ? `: ${textOf(text, node.type)}` : '';

  return {
    title: 'Convert to arrow function',
    edits: [
      {
        start: node.loc.start.offset,
        end: node.loc.end.offset,
        text: `${modifier}fn (${params})${returnType} => ${textOf(text, returned)}`,
      },
    ],
  };
}
