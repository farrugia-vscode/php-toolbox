/** Negating a condition the way a person would write it, not by wrapping it in `!(…)`. */

const OPPOSITE: Record<string, string> = {
  '===': '!==',
  '!==': '===',
  '==': '!=',
  '!=': '==',
  '<>': '==',
  '<': '>=',
  '>=': '<',
  '>': '<=',
  '<=': '>',
  instanceof: 'instanceof',
};

/** Operators that keep their meaning only inside parentheses once negated. */
const LOOSE = new Set(['&&', '||', 'and', 'or', 'xor']);

export function negate(node: any, text: string): string {
  const written = text.slice(node.loc.start.offset, node.loc.end.offset).trim();

  if (node.kind === 'unary' && node.type === '!') {
    return text.slice(node.what.loc.start.offset, node.what.loc.end.offset).trim();
  }

  if (node.kind === 'boolean') {
    return written.toLowerCase() === 'true' ? 'false' : 'true';
  }

  if (node.kind === 'bin' && OPPOSITE[node.type] && node.type !== 'instanceof') {
    const left = text.slice(node.left.loc.start.offset, node.left.loc.end.offset);
    const right = text.slice(node.right.loc.start.offset, node.right.loc.end.offset);

    return `${left.trim()} ${OPPOSITE[node.type]} ${right.trim()}`;
  }

  if (node.kind === 'bin' && LOOSE.has(node.type)) {
    return `!(${written})`;
  }

  if (node.kind === 'variable' || node.kind === 'call' || node.kind === 'propertylookup' || node.kind === 'staticlookup') {
    return `!${written}`;
  }

  return `!(${written})`;
}
