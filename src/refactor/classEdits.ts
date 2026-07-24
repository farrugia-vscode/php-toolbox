import type { Declaration, ParsedFile } from '../php/parser';
import { indentAt, indentUnit } from './textLayout';

/** The type whose body contains the offset. */
export function classAt(parsed: ParsedFile, offset: number): Declaration | null {
  return parsed.declarations
    .filter((declaration) => declaration.bodyStart <= offset && declaration.bodyEnd >= offset)
    .sort((first, second) => first.bodyEnd - first.bodyStart - (second.bodyEnd - second.bodyStart))[0] ?? null;
}

/** Walks past the semicolon a member declaration ends with, which the parser leaves out. */
function afterMember(text: string, end: number): number {
  const semicolon = text.indexOf(';', end);

  if (semicolon === -1 || text.slice(end, semicolon).trim() !== '') {
    return end;
  }

  return semicolon + 1;
}

/** Where a new member goes, and what has to separate it from what is already there. */
export interface MemberAnchor {
  offset: number;
  isFirstInBody: boolean;
  /** The member before it is of another kind, so the two want a blank line between them. */
  isAfterOtherKind: boolean;
}

/**
 * Where a new member belongs: right after the last one of its kind, so constants stay with
 * constants and properties with properties, and at the top of the body when there is none.
 */
export function memberInsertOffset(
  text: string,
  parsed: ParsedFile,
  declaration: Declaration,
  kind: 'constant' | 'property' | 'method',
): MemberAnchor {
  const owned = <T extends { className: string; start: number; end: number }>(members: T[]): T[] =>
    members.filter(
      (member) =>
        member.className === declaration.fqn &&
        member.start >= declaration.bodyStart &&
        member.end <= declaration.bodyEnd,
    );

  const constants = owned(parsed.constants);
  const properties = owned(parsed.properties);

  if (kind === 'method') {
    const methods = owned(parsed.methods);

    return methods.length > 0
      ? { offset: methods[methods.length - 1].end, isFirstInBody: false, isAfterOtherKind: true }
      : { offset: declaration.bodyStart, isFirstInBody: true, isAfterOtherKind: false };
  }

  const candidates = kind === 'constant' ? [constants] : [properties, constants];
  const previous = candidates.find((members) => members.length > 0);

  if (!previous) {
    return { offset: declaration.bodyStart, isFirstInBody: true, isAfterOtherKind: false };
  }

  return {
    offset: afterMember(text, previous[previous.length - 1].end),
    isFirstInBody: false,
    isAfterOtherKind: previous !== (kind === 'constant' ? constants : properties),
  };
}

/** Indentation members of the class are written at. */
export function memberIndent(text: string, parsed: ParsedFile, declaration: Declaration): string {
  const first = [...parsed.methods, ...parsed.properties, ...parsed.constants].find(
    (member) => member.className === declaration.fqn,
  );

  return first ? indentAt(text, first.start) : `${indentAt(text, declaration.start)}${indentUnit(text)}`;
}

/** Text to insert for a new member at the given anchor, blank lines included. */
export function memberText(code: string, indent: string, anchor: MemberAnchor): string {
  if (anchor.isFirstInBody) {
    return `\n${indent}${code}\n`;
  }

  return anchor.isAfterOtherKind ? `\n\n${indent}${code}` : `\n${indent}${code}`;
}
