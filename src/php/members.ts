import { taggedTypeBefore } from './docblock';
/**
 * The members and calls a PHP file contains, built from the parser AST.
 *
 * Kept apart from `parser.ts` so the walk there stays about names, while everything a
 * refactoring needs to know about a method — its signature, its body, who calls it —
 * lives in one place.
 */

export type Visibility = 'public' | 'protected' | 'private';

export interface ParamInfo {
  /** Variable name, without the leading `$`. */
  name: string;
  type: string | null;
  defaultText: string | null;
  isVariadic: boolean;
  isByRef: boolean;
  /** Constructor promotion: the parameter also declares a property. */
  isPromoted: boolean;
  /** Offsets of the whole parameter, modifiers and default included. */
  start: number;
  end: number;
}

export interface MethodDeclaration {
  name: string;
  /** Fully qualified name of the declaring type, empty for a plain function. */
  className: string;
  visibility: Visibility;
  isStatic: boolean;
  isAbstract: boolean;
  /** An `#[Attribute]` is written above it, so something may reach it by reflection. */
  hasAttributes: boolean;
  params: ParamInfo[];
  returnType: string | null;
  /** The `@return` of the docblock, which is where generics are written: `HasMany<Invoice, $this>`. */
  docReturnType: string | null;
  nameStart: number;
  nameEnd: number;
  /** Offsets of the whole declaration, from the first modifier to the closing brace. */
  start: number;
  end: number;
  /** Offsets just inside the braces, null for an abstract or interface method. */
  bodyStart: number | null;
  bodyEnd: number | null;
  /** Offsets just inside the parentheses of the parameter list. */
  paramsStart: number;
  paramsEnd: number;
}

export interface PropertyDeclaration {
  name: string;
  className: string;
  visibility: Visibility;
  isStatic: boolean;
  hasAttributes: boolean;
  type: string | null;
  /** The `@var` of the docblock, generics included: `Collection<int, Invoice>`. */
  docType: string | null;
  nameStart: number;
  nameEnd: number;
  start: number;
  end: number;
}

export interface ClassConstant {
  name: string;
  className: string;
  visibility: Visibility;
  hasAttributes: boolean;
  nameStart: number;
  nameEnd: number;
  start: number;
  end: number;
}

/** How the receiver of a call was written, which is what tells us how sure we can be. */
export type ReceiverKind = 'this' | 'self' | 'static' | 'parent' | 'type' | 'expression';

export interface CallArgument {
  /** Argument label of a named argument (`limit: 10`), null for a positional one. */
  label: string | null;
  start: number;
  end: number;
}

export interface MethodCall {
  name: string;
  receiverKind: ReceiverKind;
  receiverText: string;
  isStatic: boolean;
  /** Type the call is written on for a static call, as written. */
  receiverType: string | null;
  nameStart: number;
  nameEnd: number;
  start: number;
  end: number;
  /** Offsets just inside the parentheses. */
  argsStart: number;
  argsEnd: number;
  args: CallArgument[];
  /** Set when an argument is spread (`...$args`), which no rewrite can map back. */
  hasSpread: boolean;
}

/**
 * What a mention does to a member: reads its value, replaces it, or both.
 *
 * `readwrite` is not a hedge, it is the exact answer for `$this->total += 1`, `$this->count++`
 * and `$this->items['k'] = 1`: the old value is read before the new one is stored.
 */
export type AccessMode = 'read' | 'write' | 'readwrite';

/** A member read or written without being called: `$this->total`, `Order::STATUS`. */
export interface MemberAccess {
  name: string;
  kind: 'property' | 'staticProperty' | 'constant';
  receiverKind: ReceiverKind;
  receiverText: string;
  receiverType: string | null;
  access: AccessMode;
  nameStart: number;
  nameEnd: number;
}

function visibilityOf(node: any): Visibility {
  const visibility = node.visibility;

  return visibility === 'protected' || visibility === 'private' ? visibility : 'public';
}

function hasAttributes(node: any): boolean {
  return (node?.attrGroups ?? []).length > 0;
}

/** Types are taken from the source rather than rebuilt: unions and intersections come free. */
export function typeText(node: any, text: string, isNullable = false): string | null {
  if (!node?.loc) {
    return null;
  }

  const written = text.slice(node.loc.start.offset, node.loc.end.offset).trim();

  if (!written) {
    return null;
  }

  return isNullable && !written.startsWith('?') && !written.includes('|') ? `?${written}` : written;
}

/** Visibility a constructor parameter is promoted with, or null when it is a plain one. */
export function promotedVisibility(node: any): Visibility | null {
  const flags = typeof node.flags === 'number' ? node.flags : 0;

  if (flags === 2) {
    return 'protected';
  }
  if (flags === 4) {
    return 'private';
  }

  return flags === 1 ? 'public' : null;
}

export function paramFrom(node: any, text: string): ParamInfo {
  return {
    name: typeof node.name === 'string' ? node.name : node.name?.name ?? '',
    type: typeText(node.type, text, node.nullable === true),
    defaultText: node.value ? text.slice(node.value.loc.start.offset, node.value.loc.end.offset) : null,
    isVariadic: node.variadic === true,
    isByRef: node.byref === true,
    isPromoted: promotedVisibility(node) !== null,
    start: node.loc.start.offset,
    end: node.loc.end.offset,
  };
}

/** Offsets inside the parentheses that follow `from`, or a collapsed pair when there are none. */
function parenthesesAfter(text: string, from: number, end: number): [number, number] {
  const open = text.indexOf('(', from);

  if (open === -1 || open > end) {
    return [from, from];
  }

  let depth = 0;

  for (let offset = open; offset <= end && offset < text.length; offset++) {
    const character = text[offset];

    if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth--;

      if (depth === 0) {
        return [open + 1, offset];
      }
    }
  }

  return [open + 1, open + 1];
}

export function methodFrom(node: any, text: string, className: string): MethodDeclaration {
  const nameStart = node.name.loc.start.offset;
  const nameEnd = node.name.loc.end.offset;
  const end = node.loc.end.offset;
  const [paramsStart, paramsEnd] = parenthesesAfter(text, nameEnd, end);

  return {
    name: node.name.name,
    className,
    visibility: visibilityOf(node),
    isStatic: node.isStatic === true,
    isAbstract: node.isAbstract === true || node.body === null,
    hasAttributes: hasAttributes(node),
    params: (node.arguments ?? []).map((argument: any) => paramFrom(argument, text)),
    returnType: typeText(node.type, text, node.nullable === true),
    docReturnType: taggedTypeBefore(text, node.loc.start.offset, 'return'),
    nameStart,
    nameEnd,
    start: node.loc.start.offset,
    end,
    bodyStart: node.body?.loc ? node.body.loc.start.offset + 1 : null,
    bodyEnd: node.body?.loc ? node.body.loc.end.offset - 1 : null,
    paramsStart,
    paramsEnd,
  };
}

/** `$this`, `self`, a type name or anything else: the receiver decides how safe a rewrite is. */
function receiverOf(node: any, text: string): Pick<MethodCall, 'receiverKind' | 'receiverText' | 'receiverType'> {
  const written = node?.loc ? text.slice(node.loc.start.offset, node.loc.end.offset) : '';
  const bare = written.replace(/^\\/, '');

  if (node?.kind === 'variable' && node.name === 'this') {
    return { receiverKind: 'this', receiverText: '$this', receiverType: null };
  }

  if (node?.kind === 'name' || node?.kind === 'classreference' || node?.kind === 'identifier') {
    const lowered = bare.toLowerCase();

    if (lowered === 'self' || lowered === 'static' || lowered === 'parent') {
      return { receiverKind: lowered as ReceiverKind, receiverText: bare, receiverType: null };
    }

    return { receiverKind: 'type', receiverText: bare, receiverType: bare };
  }

  return { receiverKind: 'expression', receiverText: written, receiverType: null };
}

/** A method call, or null when the node is a call to something that is not a method. */
export function callFrom(node: any, text: string): MethodCall | null {
  const target = node.what;

  if (target?.kind !== 'propertylookup' && target?.kind !== 'staticlookup' && target?.kind !== 'nullsafepropertylookup') {
    return null;
  }

  const offset = target.offset;

  // `$object->$name()` names the method at runtime: nothing to match on.
  if (offset?.kind !== 'identifier' && offset?.kind !== 'name') {
    return null;
  }

  const nameStart = offset.loc.start.offset;
  const nameEnd = offset.loc.end.offset;
  const end = node.loc.end.offset;
  const [argsStart, argsEnd] = parenthesesAfter(text, nameEnd, end);
  return {
    name: offset.name,
    isStatic: target.kind === 'staticlookup',
    ...receiverOf(target.what, text),
    nameStart,
    nameEnd,
    start: node.loc.start.offset,
    end,
    argsStart,
    argsEnd,
    args: argumentsOf(node),
    hasSpread: hasSpread(node),
  };
}

/** The arguments of a call or an instantiation, named ones labelled. */
function argumentsOf(node: any): CallArgument[] {
  return (node.arguments ?? []).map((argument: any) => ({
    label: argument.kind === 'namedargument' ? argument.name : null,
    start: argument.loc.start.offset,
    end: argument.loc.end.offset,
  }));
}

/** True when an argument is spread (`...$args`), which no position can be read through. */
function hasSpread(node: any): boolean {
  return (node.arguments ?? []).some(
    (argument: any) =>
      argument.kind === 'variadicplaceholder' || argument.byref === true || argument.unpack === true,
  );
}

/**
 * A `new Foo(...)` site.
 *
 * A promoted property is never assigned anywhere: it is handed its value here, once, and a
 * `readonly` class has no other write. Without these sites, "where is this written" answers
 * nothing for the very classes that are written the least.
 */
export interface Instantiation {
  /** Type as written, `self` and `static` included, and null when it is computed at runtime. */
  typeText: string;
  /** Fully qualified name the walk resolved it to, null when nothing could. */
  fqn: string | null;
  args: CallArgument[];
  hasSpread: boolean;
  /** Offsets of the type name, which is what a listing points at. */
  nameStart: number;
  nameEnd: number;
}

/** An instantiation, or null when the class is named by an expression. */
export function instantiationFrom(node: any, text: string, fqn: string | null): Instantiation | null {
  const target = node.what;

  if (!target?.loc) {
    return null;
  }

  const typeText = text.slice(target.loc.start.offset, target.loc.end.offset);

  // `new $class(...)` and `new ($factory())(...)`: the type is only known at runtime.
  if (!/^\\?[\w\\]+$/.test(typeText)) {
    return null;
  }

  return {
    typeText,
    fqn,
    args: argumentsOf(node),
    hasSpread: hasSpread(node),
    nameStart: target.loc.start.offset,
    nameEnd: target.loc.end.offset,
  };
}

/**
 * A property or constant reached on an object or a class, or null for anything else.
 *
 * The walk owns `access`: what a mention does to the member is written by the node above it
 * (an assignment, an `unset`, a `foreach` target), never by the mention itself.
 */
export function accessFrom(node: any, text: string, access: AccessMode): MemberAccess | null {
  const isStatic = node.kind === 'staticlookup';
  const offset = node.offset;

  if (!isStatic && offset?.kind !== 'identifier' && offset?.kind !== 'name') {
    return null;
  }

  // `Foo::$bar` names a static property, `Foo::BAR` a constant, `Foo::class` neither.
  const name = typeof offset?.name === 'string' ? offset.name : null;

  if (name === null || (isStatic && name === 'class')) {
    return null;
  }

  const kind = isStatic ? (offset.kind === 'variable' ? 'staticProperty' : 'constant') : 'property';

  return {
    name,
    kind,
    ...receiverOf(node.what, text),
    access,
    nameStart: offset.loc.start.offset,
    nameEnd: offset.loc.end.offset,
  };
}

/** Offsets of the name inside a member declaration, which the parser reports unevenly. */
function nameRange(node: any, text: string, group: any, written: string): [number, number] {
  if (node.name?.loc) {
    return [node.name.loc.start.offset, node.name.loc.end.offset];
  }

  const found = text.indexOf(written, group.loc.start.offset);

  return found === -1 ? [group.loc.start.offset, group.loc.start.offset] : [found, found + written.length];
}

export function propertyFrom(node: any, text: string, className: string, group: any): PropertyDeclaration {
  const name = typeof node.name === 'string' ? node.name : node.name?.name ?? '';
  const [nameStart, nameEnd] = nameRange(node, text, group, `$${name}`);

  return {
    name,
    className,
    visibility: visibilityOf(group),
    isStatic: group.isStatic === true,
    hasAttributes: hasAttributes(group) || hasAttributes(node),
    type: typeText(node.type, text, node.nullable === true),
    docType: taggedTypeBefore(text, group.loc.start.offset, 'var'),
    // The `$` is part of the written name, but not of the name a rename replaces.
    nameStart: text[nameStart] === '$' ? nameStart + 1 : nameStart,
    nameEnd,
    start: group.loc.start.offset,
    end: group.loc.end.offset,
  };
}

export function constantFrom(node: any, text: string, className: string, group: any): ClassConstant {
  const name = typeof node.name === 'string' ? node.name : node.name?.name ?? '';
  const [nameStart, nameEnd] = nameRange(node, text, group, name);

  return {
    name,
    className,
    visibility: visibilityOf(group),
    hasAttributes: hasAttributes(group) || hasAttributes(node),
    nameStart,
    nameEnd,
    start: group.loc.start.offset,
    end: group.loc.end.offset,
  };
}
