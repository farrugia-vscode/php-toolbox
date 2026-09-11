import { parseAst } from './engine';
import { collectExpressions, type ExpressionNode } from './expressions';
import { paramFrom, typeText, type ParamInfo } from './members';
import { addUse, collectCallWrites, collectWrites } from './variables';

/** One mention of a variable, and whether that mention assigns to it. */
export interface VariableUse {
  name: string;
  start: number;
  end: number;
  isWrite: boolean;
}

export interface Span {
  start: number;
  end: number;
}

/** A `{ … }` and the statements directly inside it: what an extraction can be cut out of. */
export interface Block extends Span {
  statements: Span[];
}

export type ScopeKind = 'method' | 'function' | 'closure' | 'arrow' | 'file';

/** A function body seen as a scope: its variables, its blocks and what it does with control flow. */
export interface FunctionScope extends Span {
  kind: ScopeKind;
  name: string;
  /** Short name of the enclosing class: enough to tell scopes of one file apart. */
  className: string;
  isStatic: boolean;
  bodyStart: number;
  bodyEnd: number;
  returnType: string | null;
  params: ParamInfo[];
  uses: VariableUse[];
  blocks: Block[];
  usesThis: boolean;
  hasYield: boolean;
  returns: Span[];
  /** `break`, `continue` and `goto`: jumping out of an extracted block is not expressible. */
  jumps: Span[];
  /** Loops and switches, the only things a `break` or `continue` may be aimed at. */
  loops: Span[];
}

export interface FileScopes {
  functions: FunctionScope[];
  expressions: ExpressionNode[];
}

const FUNCTION_KINDS: Record<string, ScopeKind> = {
  method: 'method',
  function: 'function',
  closure: 'closure',
  arrowfunc: 'arrow',
};

function scopeFrom(node: any, kind: ScopeKind, className: string, text: string): FunctionScope {
  const body = node.body;
  const isExpressionBody = kind === 'arrow';

  return {
    kind,
    name: node.name?.name ?? node.name ?? '',
    className,
    isStatic: node.isStatic === true,
    start: node.loc.start.offset,
    end: node.loc.end.offset,
    bodyStart: body?.loc ? body.loc.start.offset + (isExpressionBody ? 0 : 1) : node.loc.end.offset,
    bodyEnd: body?.loc ? body.loc.end.offset - (isExpressionBody ? 0 : 1) : node.loc.end.offset,
    returnType: typeText(node.type, text, node.nullable === true),
    params: (node.arguments ?? []).map((argument: any) => paramFrom(argument, text)),
    uses: [],
    blocks: [],
    usesThis: false,
    hasYield: false,
    returns: [],
    jumps: [],
    loops: [],
  };
}

const LOOP_KINDS = new Set(['for', 'foreach', 'while', 'do', 'switch']);

/**
 * Reads the file as a set of nested scopes. Everything the extract and inline refactorings
 * decide — which variables become parameters, which ones have to be returned — comes from here.
 */
export function analyzeScopes(text: string): FileScopes {
  const ast = parseAst(text);

  if (!ast) {
    return { functions: [], expressions: [] };
  }

  const functions: FunctionScope[] = [];
  const file: FunctionScope = {
    kind: 'file', name: '', className: '', isStatic: false,
    start: 0, end: text.length, bodyStart: 0, bodyEnd: text.length, returnType: null,
    params: [], uses: [], blocks: [], usesThis: false, hasYield: false, returns: [], jumps: [],
    loops: [],
  };
  functions.push(file);

  const walk = (node: any, scope: FunctionScope, className: string): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, scope, className));
      return;
    }

    const recurse = (child: any): void => walk(child, scope, className);
    const kind = FUNCTION_KINDS[node.kind];

    if (kind) {
      enterFunction(node, kind, scope, className, walk, functions, text);
      return;
    }

    if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait' || node.kind === 'enum') {
      const inner = node.name?.name ?? className;
      Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key], scope, inner));
      return;
    }

    if (node.kind === 'block' || node.kind === 'program') {
      scope.blocks.push({
        start: node.loc.start.offset,
        end: node.loc.end.offset,
        statements: (node.children ?? [])
          .filter((child: any) => child?.loc)
          .map((child: any) => ({ start: child.loc.start.offset, end: child.loc.end.offset })),
      });
    }

    if (node.kind === 'variable') {
      addUse(scope, node, false);
      recurse(node.offset);
      return;
    }

    if (node.kind === 'assign' || node.kind === 'assignref') {
      collectWrites(node.left, scope, recurse);
      recurse(node.right);
      return;
    }

    if (node.kind === 'pre' || node.kind === 'post') {
      collectWrites(node.what, scope, recurse);
      return;
    }

    if (node.kind === 'foreach') {
      recurse(node.source);
      collectWrites(node.key, scope, recurse);
      collectWrites(node.value, scope, recurse);
      recurse(node.body);
      return;
    }

    if (node.kind === 'catch') {
      collectWrites(node.variable, scope, recurse);
      recurse(node.body);
      return;
    }

    if (node.kind === 'static' || node.kind === 'global') {
      (node.variables ?? node.items ?? []).forEach((item: any) =>
        collectWrites(item?.kind === 'staticvariable' ? item.variable : item, scope, recurse),
      );
      return;
    }

    if (node.kind === 'call') {
      collectCallWrites(node, scope, recurse);
      return;
    }

    if (node.kind === 'yield' || node.kind === 'yieldfrom') {
      scope.hasYield = true;
    }

    if (node.kind === 'return') {
      scope.returns.push({ start: node.loc.start.offset, end: node.loc.end.offset });
    }

    if (node.kind === 'break' || node.kind === 'continue' || node.kind === 'goto') {
      scope.jumps.push({ start: node.loc.start.offset, end: node.loc.end.offset });
    }

    if (LOOP_KINDS.has(node.kind)) {
      scope.loops.push({ start: node.loc.start.offset, end: node.loc.end.offset });
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key], scope, className));
  };

  walk(ast, file, '');

  return { functions, expressions: collectExpressions(ast) };
}

/**
 * A nested function is its own scope, but the variables it captures are read where it is
 * written: `use ($total)` and the free variables of an arrow function belong to the parent.
 */
function enterFunction(
  node: any,
  kind: ScopeKind,
  parent: FunctionScope,
  className: string,
  walk: (node: any, scope: FunctionScope, className: string) => void,
  functions: FunctionScope[],
  text: string,
): void {
  const scope = scopeFrom(node, kind, kind === 'method' ? className : parent.className, text);
  functions.push(scope);

  scope.params.forEach((param) => {
    scope.uses.push({ name: param.name, start: param.start, end: param.end, isWrite: true });
  });

  (node.arguments ?? []).forEach((argument: any) => walk(argument.value, scope, className));
  (node.uses ?? []).forEach((used: any) => {
    addUse(parent, used, used.byref === true);
    addUse(scope, used, true);
  });

  walk(node.body, scope, className);

  if (scope.usesThis) {
    parent.usesThis = true;
  }

  if (kind !== 'arrow') {
    return;
  }

  // An arrow function captures by value, without saying so: its free variables are reads.
  const declared = new Set(scope.params.map((param) => param.name));

  scope.uses
    .filter((use) => !declared.has(use.name))
    .forEach((use) => parent.uses.push({ ...use, isWrite: false }));
}

/** Every scope containing the offsets, innermost first: a closure, then the method holding it. */
export function enclosingScopes(scopes: FileScopes, start: number, end: number): FunctionScope[] {
  return scopes.functions
    .filter((scope) => scope.bodyStart <= start && scope.bodyEnd >= end)
    .sort((first, second) => first.bodyEnd - first.bodyStart - (second.bodyEnd - second.bodyStart));
}

/** The innermost scope containing the offsets, which is the one a refactoring works in. */
export function scopeAt(scopes: FileScopes, start: number, end: number): FunctionScope | null {
  return enclosingScopes(scopes, start, end)[0] ?? null;
}
