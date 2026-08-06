/**
 * What a missing member looks like once written, and the types its arguments imply.
 *
 * The point is not to guess right every time: it is to write the declaration with the
 * signature the call already spells out, so what is left to do is the body.
 */

import type { ParamInfo } from '../php/members';
import type { ParsedFile } from '../php/parser';

/** One parameter of the member being written, as read from one argument of the call. */
export interface InferredParam {
  name: string;
  type: string | null;
}

/** Where the member has to be written, and what shape it takes there. */
export interface MemberDraft {
  kind: 'method' | 'property';
  name: string;
  params: InferredParam[];
  /** No body at all, which is what an interface declares. */
  isSignatureOnly: boolean;
  visibility: 'public' | 'private';
  /** Type of the property being drafted, when the assignment says what it holds. */
  type: string | null;
}

const NUMBER_TYPE = (raw: string): string => (raw.includes('.') || /e/i.test(raw) ? 'float' : 'int');

/** The type a literal argument announces on its own. */
function literalType(node: any): string | null {
  if (node.kind === 'string' || node.kind === 'encapsed') {
    return 'string';
  }

  if (node.kind === 'number') {
    return NUMBER_TYPE(String(node.value ?? ''));
  }

  if (node.kind === 'boolean') {
    return 'bool';
  }

  if (node.kind === 'array') {
    return 'array';
  }

  if (node.kind === 'closure' || node.kind === 'arrowfunc') {
    return 'callable';
  }

  return null;
}

/** The class a `new Foo()` argument is, written the way the file writes it. */
function instantiatedType(node: any, text: string): string | null {
  if (node.kind !== 'new' || !node.what?.loc) {
    return null;
  }

  const written = text.slice(node.what.loc.start.offset, node.what.loc.end.offset).trim();

  // An anonymous class has no name to put in a signature.
  return /^[\\\w]+$/.test(written) ? written.split('\\').pop() ?? null : null;
}

/**
 * The type a variable was declared with, as the file wrote it.
 *
 * Only one hop: the parameter it came from, or the property it was read off. Following a
 * chain of assignments is a type inference engine, which this is not.
 */
function declaredVariableType(node: any, parsed: ParsedFile, params: ParamInfo[], className: string): string | null {
  if (node.kind === 'variable' && typeof node.name === 'string') {
    return params.find((param) => param.name === node.name)?.type ?? null;
  }

  const isThisProperty =
    node.kind === 'propertylookup' && node.what?.kind === 'variable' && node.what.name === 'this';

  if (!isThisProperty || typeof node.offset?.name !== 'string') {
    return null;
  }

  return (
    parsed.properties.find(
      (property) => property.className === className && property.name === node.offset.name,
    )?.type ?? null
  );
}

/** A readable parameter name: the one the argument already has, when it has one. */
function parameterName(node: any, index: number): string {
  if (node.kind === 'variable' && typeof node.name === 'string') {
    return node.name;
  }

  if (
    (node.kind === 'propertylookup' || node.kind === 'staticlookup') &&
    typeof node.offset?.name === 'string'
  ) {
    return node.offset.name;
  }

  return `argument${index + 1}`;
}

/** The parameter list a call implies, read from the arguments it passes. */
export function inferParams(
  args: any[],
  text: string,
  parsed: ParsedFile,
  params: ParamInfo[],
  className: string,
): InferredParam[] {
  const used = new Map<string, number>();

  return args.map((argument, index) => {
    const node = argument.kind === 'namedargument' ? argument.value : argument;
    const bare = parameterName(node, index);
    const seen = used.get(bare) ?? 0;

    used.set(bare, seen + 1);

    return {
      // `render($row, $row)` needs two names, and PHP refuses the same one twice.
      name: seen === 0 ? bare : `${bare}${seen + 1}`,
      type:
        literalType(node) ??
        instantiatedType(node, text) ??
        declaredVariableType(node, parsed, params, className),
    };
  });
}

/** The member as it will be written, indented for the class it lands in. */
export function draftText(draft: MemberDraft, indent: string, unit: string): string {
  if (draft.kind === 'property') {
    return `${indent}${draft.visibility}${draft.type ? ` ${draft.type}` : ''} $${draft.name};`;
  }

  const params = draft.params
    .map((param) => `${param.type ? `${param.type} ` : ''}$${param.name}`)
    .join(', ');
  const signature = `${indent}${draft.visibility} function ${draft.name}(${params})`;

  if (draft.isSignatureOnly) {
    return `${signature};`;
  }

  return [signature, `${indent}{`, `${indent}${unit}// TODO: implement ${draft.name}()`, `${indent}}`].join('\n');
}
