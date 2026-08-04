import type { Intention } from '.';
import { indentAt } from '../refactor/textLayout';

/** Types a docblock can say more about than the signature does. */
const VAGUE_TYPES = new Set(['array', 'iterable', 'callable', 'object', 'mixed']);

function typeName(node: any): string | null {
  if (!node) {
    return null;
  }

  if (Array.isArray(node)) {
    return node.map(typeName).filter(Boolean).join('|');
  }

  const name = typeof node.name === 'string' ? node.name : null;

  return node.nullable === true && name ? `${name}|null` : name;
}

/** A type worth annotating: one the signature cannot express on its own. */
function needsAnnotation(type: string | null): boolean {
  return type === null || VAGUE_TYPES.has(type.replace(/\|null$/, ''));
}

function annotatedType(type: string | null): string {
  const bare = (type ?? 'mixed').replace(/\|null$/, '');
  const suffix = type?.endsWith('|null') ? '|null' : '';

  return bare === 'array' || bare === 'iterable' ? `${bare}<mixed>${suffix}` : `${type ?? 'mixed'}`;
}

/** Class names thrown directly by the body — the one thing a signature never carries. */
function thrownTypes(body: any): string[] {
  const names: string[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.kind === 'throw' && node.what?.kind === 'new') {
      const name = typeName(node.what.what);

      if (name) {
        names.push(name.split('\\').pop() as string);
      }
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(body);

  return [...new Set(names)];
}

/** True when a docblock already sits above the declaration. */
function isDocumented(text: string, start: number): boolean {
  const before = text.slice(0, start).trimEnd();

  return before.endsWith('*/');
}

function block(lines: string[], indent: string): string {
  if (lines.length === 1) {
    return `/** ${lines[0]} */\n${indent}`;
  }

  return ['/**', ...lines.map((line) => ` * ${line}`), ' */'].join(`\n${indent}`) + `\n${indent}`;
}

/**
 * Writes the docblock a method is missing, and only the part of it that says something:
 * repeating `int $count` after a typed signature adds nothing, while the element type of
 * an array, and the exceptions a body throws, are nowhere else.
 */
export function documentMethod(text: string, chain: any[], offset: number): Intention | null {
  const method = chain.find((candidate) => candidate.kind === 'method');

  if (!method?.loc || isDocumented(text, method.loc.start.offset)) {
    return null;
  }

  // Only from the signature: inside the body, this would fire on every line.
  const signatureEnd = method.body?.loc ? method.body.loc.start.offset : method.loc.end.offset;

  if (offset > signatureEnd) {
    return null;
  }

  const params = (method.arguments ?? [])
    .filter((argument: any) => needsAnnotation(typeName(argument.type)))
    .map((argument: any) => `@param ${annotatedType(typeName(argument.type))} $${argument.name?.name}`);

  const returnType = typeName(method.type);
  const returns =
    returnType !== 'void' && returnType !== 'never' && needsAnnotation(returnType)
      ? [`@return ${annotatedType(returnType)}`]
      : [];
  const throws = thrownTypes(method.body).map((name) => `@throws ${name}`);
  const lines = [...params, ...returns, ...throws];

  if (lines.length === 0) {
    return null;
  }

  const start = method.loc.start.offset;

  return {
    title: 'Add PHPDoc',
    edits: [{ start, end: start, text: block(lines, indentAt(text, start)) }],
  };
}
