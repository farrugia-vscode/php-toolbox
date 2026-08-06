import type { Declaration } from './parser';

/**
 * Every type a declaration inherits from: its parent, the interfaces it implements, the
 * traits it uses, and everything those bring in turn.
 *
 * Breadth first, so the nearest relatives come first — which is what `parent::` reaches and
 * what an override copies its signature from.
 */
export function ancestorsOf(declaration: Declaration, all: Declaration[]): Declaration[] {
  const seen = new Map<string, Declaration>();
  const queue = [...declaration.interfaces, declaration.parent ?? '', ...declaration.traits].filter(Boolean);

  while (queue.length > 0) {
    const fqn = queue.shift() as string;

    if (seen.has(fqn)) {
      continue;
    }

    const found = all.find((candidate) => candidate.fqn === fqn);

    if (found) {
      seen.set(fqn, found);
      queue.push(...found.interfaces, found.parent ?? '', ...found.traits);
    }
  }

  return [...seen.values()];
}
