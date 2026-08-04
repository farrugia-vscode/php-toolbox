import type { IndexedFile } from '../php/phpIndex';
import type { Declaration } from '../php/parser';
import type { FileScopes, FunctionScope, Span } from '../php/scopes';
import { scopeAt } from '../php/scopes';
import { localAt } from '../refactor/renameLocal';

/** A member where it is declared, reduced to what the menu needs to decide. */
export interface MemberUnderCursor {
  kind: 'method' | 'property' | 'constant';
  isAbstract: boolean;
}

/**
 * What the cursor is on, decided once. Every entry of the menu reads this rather than
 * running its own scan, so an action can never disagree with its neighbour about where
 * the cursor is.
 */
export interface CursorContext {
  file: IndexedFile;
  scopes: FileScopes;
  scope: FunctionScope | null;
  selection: Span;
  /** The type declared by this file, when the cursor is on its name. */
  type: Declaration | null;
  /** The member declared here, when the cursor is on its name. */
  member: MemberUnderCursor | null;
  /** A call or a property read: the member is named, but declared elsewhere. */
  isOnMemberUsage: boolean;
  isOnLocal: boolean;
}

function isWithin(offset: number, start: number, end: number): boolean {
  return offset >= start && offset <= end;
}

function memberAt(file: IndexedFile, offset: number): MemberUnderCursor | null {
  const method = file.parsed.methods.find((candidate) =>
    isWithin(offset, candidate.nameStart, candidate.nameEnd),
  );

  if (method) {
    return { kind: 'method', isAbstract: method.isAbstract };
  }

  const property = file.parsed.properties.find((candidate) =>
    isWithin(offset, candidate.nameStart, candidate.nameEnd),
  );

  if (property) {
    return { kind: 'property', isAbstract: false };
  }

  const constant = file.parsed.constants.find((candidate) =>
    isWithin(offset, candidate.nameStart, candidate.nameEnd),
  );

  return constant ? { kind: 'constant', isAbstract: false } : null;
}

export function cursorContext(
  file: IndexedFile,
  scopes: FileScopes,
  selection: Span,
): CursorContext {
  const { start, end } = selection;

  return {
    file,
    scopes,
    scope: scopeAt(scopes, start, end),
    selection,
    // Declarations carry the offsets of their short name, which is exactly where a
    // type-wide action belongs: on the name, not on the whole body.
    type: file.parsed.declarations.find((candidate) => isWithin(start, candidate.start, candidate.end)) ?? null,
    member: memberAt(file, start),
    isOnMemberUsage:
      file.parsed.calls.some((call) => isWithin(start, call.nameStart, call.nameEnd)) ||
      file.parsed.accesses.some((access) => isWithin(start, access.nameStart, access.nameEnd)),
    isOnLocal: localAt(scopes, file.text, start) !== null,
  };
}
