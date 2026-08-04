import { parseAst } from './engine';

/** What a variable was assigned from: enough to look the type up, no more. */
export type Assigned =
  | { kind: 'member'; receiver: Receiver; name: string }
  | { kind: 'instantiation'; className: string };

export type Receiver = { kind: 'variable'; name: string } | { kind: 'this' };

function receiverOf(node: any): Receiver | null {
  if (node?.kind !== 'variable' || typeof node.name !== 'string') {
    return null;
  }

  return node.name === 'this' ? { kind: 'this' } : { kind: 'variable', name: node.name };
}

/** Reads `$site->customer`, `$site->customer()` and `new Customer()`; anything else is skipped. */
function describe(node: any): Assigned | null {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (node.kind === 'new') {
    const className = node.what?.name;
    return typeof className === 'string' ? { kind: 'instantiation', className } : null;
  }

  // A method call is the same lookup as a property, one level up the tree.
  if (node.kind === 'call') {
    return describe(node.what);
  }

  if (node.kind === 'propertylookup' || node.kind === 'nullsafepropertylookup') {
    const receiver = receiverOf(node.what);
    const name = node.offset?.name;

    if (!receiver || typeof name !== 'string') {
      return null;
    }

    return { kind: 'member', receiver, name };
  }

  return null;
}

/** Name of a type node, `?Customer` and `\App\Models\Customer` included. */
function typeName(node: any): string | null {
  if (!node) {
    return null;
  }

  if (node.kind === 'nullablekeyword' || node.kind === 'nullable') {
    return typeName(node.what ?? node.type);
  }

  return typeof node.name === 'string' ? node.name : null;
}

/**
 * The declared type of the parameter `$name` of the function `offset` sits in. A typed
 * parameter is the one place a variable says what it holds without any inference.
 */
export function findParameterType(text: string, name: string, offset: number): string | null {
  const ast = parseAst(text);

  if (!ast) {
    return null;
  }

  let found: string | null = null;
  let narrowest = Infinity;

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    const isEnclosingFunction =
      Array.isArray(node.arguments) &&
      node.loc &&
      node.loc.start.offset <= offset &&
      node.loc.end.offset >= offset;

    if (isEnclosingFunction) {
      const span = node.loc.end.offset - node.loc.start.offset;
      const parameter = node.arguments.find((argument: any) => argument?.name?.name === name);
      const declared = parameter ? typeName(parameter.type) : null;

      // The innermost function wins: a closure shadows the method holding it.
      if (declared && span < narrowest) {
        found = declared;
        narrowest = span;
      }
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

  return found;
}

/**
 * What `$name` last held before `offset`. The last assignment wins: a variable reassigned
 * in a loop or a branch reads with the type it was given closest above the cursor, which
 * is what someone looking at the line expects.
 */
export function findAssignment(text: string, name: string, offset: number): Assigned | null {
  const ast = parseAst(text);

  if (!ast) {
    return null;
  }

  let closest: { assigned: Assigned; start: number } | null = null;

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    const isAssignmentToName =
      node.kind === 'assign' &&
      node.left?.kind === 'variable' &&
      node.left.name === name &&
      node.loc?.start.offset < offset;

    if (isAssignmentToName) {
      const assigned = describe(node.right);
      const start = node.loc.start.offset;

      if (assigned && (closest === null || start > closest.start)) {
        closest = { assigned, start };
      }
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

  return closest === null ? null : (closest as { assigned: Assigned }).assigned;
}
