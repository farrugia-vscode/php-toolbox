/** Expression nodes of a file, which is what the extract refactorings select over. */

export interface ExpressionNode {
  kind: string;
  start: number;
  end: number;
  /** Free of calls, `new` and variables: it can become a constant. */
  isConstant: boolean;
  /** Contains a call, `new`, or an increment: repeating it would repeat the effect. */
  hasEffect: boolean;
}

const EXPRESSION_KINDS = new Set([
  'bin', 'unary', 'pre', 'post', 'call', 'new', 'variable', 'offsetlookup', 'propertylookup',
  'nullsafepropertylookup', 'staticlookup', 'string', 'number', 'boolean', 'array', 'cast',
  'retif', 'isset', 'empty', 'clone', 'closure', 'arrowfunc', 'encapsed', 'magic', 'match',
  'parenthesis', 'silence', 'nullkeyword', 'staticreference', 'selfreference', 'parentreference',
  'constref', 'name', 'print', 'list', 'entry', 'assign',
]);

/** Operators bind loosely: moved into other code, these need parentheses to keep their meaning. */
export const COMPOSITE_KINDS = new Set(['bin', 'retif', 'unary', 'assign', 'cast', 'clone', 'print', 'match']);

const EFFECT_KINDS = new Set(['call', 'new', 'pre', 'post', 'assign', 'assignref', 'clone', 'print', 'silence']);

const CONSTANT_KINDS = new Set(['string', 'number', 'boolean', 'nullkeyword', 'array', 'entry', 'bin', 'unary', 'staticlookup', 'name', 'constref', 'magic', 'parenthesis']);

/**
 * Every expression the file contains, innermost last so a lookup by offsets can pick the
 * smallest node that matches a selection.
 */
export function collectExpressions(ast: any): ExpressionNode[] {
  const found: ExpressionNode[] = [];

  const walk = (node: any): { isConstant: boolean; hasEffect: boolean } => {
    if (!node || typeof node !== 'object') {
      return { isConstant: true, hasEffect: false };
    }

    if (Array.isArray(node)) {
      return node.map(walk).reduce(
        (merged, child) => ({
          isConstant: merged.isConstant && child.isConstant,
          hasEffect: merged.hasEffect || child.hasEffect,
        }),
        { isConstant: true, hasEffect: false },
      );
    }

    let isConstant = node.kind === undefined || CONSTANT_KINDS.has(node.kind);
    let hasEffect = EFFECT_KINDS.has(node.kind);

    for (const key of Object.keys(node)) {
      if (key === 'loc') {
        continue;
      }

      const child = walk(node[key]);
      isConstant = isConstant && child.isConstant;
      hasEffect = hasEffect || child.hasEffect;
    }

    if (node.loc && EXPRESSION_KINDS.has(node.kind)) {
      found.push({
        kind: node.kind,
        start: node.loc.start.offset,
        end: node.loc.end.offset,
        isConstant,
        hasEffect,
      });
    }

    return { isConstant, hasEffect };
  };

  walk(ast);

  return found;
}

/** The smallest expression covering exactly the given offsets, or null. */
export function expressionAt(
  expressions: ExpressionNode[],
  start: number,
  end: number,
): ExpressionNode | null {
  const exact = expressions
    .filter((expression) => expression.start === start && expression.end === end)
    .sort((first, second) => second.end - second.start - (first.end - first.start));

  return exact[0] ?? null;
}
