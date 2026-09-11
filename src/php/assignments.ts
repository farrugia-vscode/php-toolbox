import { parseAst } from './engine';

/** What a variable was assigned from: enough to look the type up, no more. */
export type Assigned =
  /** `$site->customer` or `$site->customer()`: a property read, or a method called, on a receiver. */
  | { kind: 'member'; receiver: Receiver; name: string; isCall: boolean }
  | { kind: 'staticMember'; className: string; name: string; isCall: boolean }
  | { kind: 'instantiation'; className: string }
  /** `app(Customer::class)`: a function handed a class name, which may well build it. */
  | { kind: 'factoryCall'; callee: string; className: string }
  /** Any other chain of calls and accesses, kept as written for whoever can follow it. */
  | { kind: 'expression'; text: string };

export type Receiver = { kind: 'variable'; name: string } | { kind: 'this' };

function receiverOf(node: any): Receiver | null {
  if (node?.kind !== 'variable' || typeof node.name !== 'string') {
    return null;
  }

  return node.name === 'this' ? { kind: 'this' } : { kind: 'variable', name: node.name };
}

const CHAIN_KINDS = new Set(['call', 'propertylookup', 'nullsafepropertylookup', 'staticlookup']);

/**
 * Reads `$site->customer`, `Config::pricing()` and `new Customer()` for what they are; a
 * longer chain, `$this->reader->record()`, is kept as text and followed link by link later.
 */
function describe(node: any, text: string): Assigned | null {
  const described = describeShape(node);

  if (described || !CHAIN_KINDS.has(node?.kind) || !node.loc) {
    return described;
  }

  return { kind: 'expression', text: text.slice(node.loc.start.offset, node.loc.end.offset) };
}

function describeShape(node: any): Assigned | null {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (node.kind === 'new') {
    const className = node.what?.name;
    return typeof className === 'string' ? { kind: 'instantiation', className } : null;
  }

  if (node.kind === 'call') {
    const className = classArgumentOf(node);

    if (node.what?.kind === 'name' && typeof node.what.name === 'string' && className !== null) {
      return { kind: 'factoryCall', callee: node.what.name, className };
    }

    // A method call is the same lookup as a property, one level up the tree, but the
    // member it names is a method: the type asked for is what it returns.
    const callee = describeShape(node.what);

    return callee && (callee.kind === 'member' || callee.kind === 'staticMember') ? { ...callee, isCall: true } : callee;
  }

  // `Configuration::pricing()`: the type is whatever the static method returns.
  if (node.kind === 'staticlookup') {
    const className = node.what?.name;
    const name = node.offset?.name;

    if (typeof className !== 'string' || typeof name !== 'string') {
      return null;
    }

    return { kind: 'staticMember', className, name, isCall: false };
  }

  if (node.kind === 'propertylookup' || node.kind === 'nullsafepropertylookup') {
    const receiver = receiverOf(node.what);
    const name = node.offset?.name;

    if (!receiver || typeof name !== 'string') {
      return null;
    }

    return { kind: 'member', receiver, name, isCall: false };
  }

  return null;
}

/** The class a call names as its first argument, `Customer::class`, or null when it names none. */
function classArgumentOf(call: any): string | null {
  const argument = call.arguments?.[0];

  if (argument?.kind !== 'staticlookup' || argument.offset?.name !== 'class') {
    return null;
  }

  return typeof argument.what?.name === 'string' ? argument.what.name : null;
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

/** One assignment, kept with the variable it writes to and where it is written. */
export interface AssignmentSite {
  name: string;
  start: number;
  assigned: Assigned;
}

/**
 * Every assignment the file makes, in one pass.
 *
 * Read whole rather than one variable at a time: resolving what a chain of calls reaches
 * asks the same file about a dozen variables, and parsing it again for each is what makes
 * a project-wide search slow.
 */
export function findAssignments(text: string): AssignmentSite[] {
  const ast = parseAst(text);

  if (!ast) {
    return [];
  }

  const found: AssignmentSite[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.kind === 'assign' && node.left?.kind === 'variable' && typeof node.left.name === 'string') {
      const assigned = describe(node.right, text);

      if (assigned && node.loc) {
        found.push({ name: node.left.name, start: node.loc.start.offset, assigned });
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
export function lastAssignmentSite(sites: AssignmentSite[], name: string, offset: number): AssignmentSite | null {
  let closest: AssignmentSite | null = null;

  for (const site of sites) {
    if (site.name === name && site.start < offset && (closest === null || site.start > closest.start)) {
      closest = site;
    }
  }

  return closest;
}

export function lastAssignment(sites: AssignmentSite[], name: string, offset: number): Assigned | null {
  return lastAssignmentSite(sites, name, offset)?.assigned ?? null;
}

export function findAssignment(text: string, name: string, offset: number): Assigned | null {
  return lastAssignment(findAssignments(text), name, offset);
}
