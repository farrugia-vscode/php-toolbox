import { parseAst } from './engine';
import type { Span } from './scopes';

/**
 * The syntax spans covering an offset, innermost first and each one strictly wider than
 * the last. This is what an expanding selection walks up.
 */
export function enclosingSpans(text: string, offset: number): Span[] {
  const ast = parseAst(text);

  if (!ast) {
    return [];
  }

  const found: Span[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.loc && typeof node.kind === 'string') {
      const { start, end } = node.loc;

      if (start.offset <= offset && end.offset >= offset && end.offset > start.offset) {
        found.push({ start: start.offset, end: end.offset });
      }
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

  const widening: Span[] = [];

  for (const span of found.sort((first, second) => first.end - first.start - (second.end - second.start))) {
    const previous = widening[widening.length - 1];

    // Two nodes often share their bounds (an expression and the statement holding it);
    // stopping on the same selection twice reads as a keystroke that did nothing.
    if (!previous || span.start < previous.start || span.end > previous.end) {
      widening.push(span);
    }
  }

  return widening;
}

/** Content of a quoted string, so a selection can stop inside the quotes first. */
export function stringContentAt(text: string, offset: number): Span | null {
  const ast = parseAst(text);

  if (!ast) {
    return null;
  }

  let found: Span | null = null;

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    const isQuoted =
      (node.kind === 'string' || node.kind === 'encapsed') &&
      node.loc &&
      typeof node.raw === 'string' &&
      /^['"]/.test(node.raw) &&
      node.loc.start.offset < offset &&
      node.loc.end.offset > offset;

    if (isQuoted) {
      found = { start: node.loc.start.offset + 1, end: node.loc.end.offset - 1 };
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

  return found;
}
