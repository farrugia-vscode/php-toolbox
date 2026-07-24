import { parseAst } from './engine';

/** The syntax nodes covering an offset, innermost first. */
export function nodeChain(text: string, offset: number): any[] {
  const ast = astOf(text);

  if (!ast) {
    return [];
  }

  const found: any[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.loc && typeof node.kind === 'string') {
      if (node.loc.start.offset > offset || node.loc.end.offset < offset) {
        // A node that does not cover the offset cannot hold one that does.
        if (node.loc.start.offset > offset) {
          return;
        }
      } else {
        found.push(node);
      }
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

  return found.sort(
    (first, second) =>
      first.loc.end.offset - first.loc.start.offset - (second.loc.end.offset - second.loc.start.offset),
  );
}

let cached: { text: string; ast: any } | null = null;

/** The tree of the file being edited, parsed once per revision. */
export function astOf(text: string): any | null {
  if (cached?.text !== text) {
    cached = { text, ast: parseAst(text) };
  }

  return cached.ast;
}
