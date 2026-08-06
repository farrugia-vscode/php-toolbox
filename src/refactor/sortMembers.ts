import * as vscode from 'vscode';
import type { Visibility } from '../php/members';
import type { Declaration, ParsedFile } from '../php/parser';
import { indexedFile } from '../php/phpIndex';
import { activeTarget, applyPlan } from './apply';
import { classAt } from './classEdits';
import type { Planned } from './plan';
import { docblockStart, lineStartOf } from './textLayout';

/** The groups a class body reads best in, in that order. */
const GROUPS = ['constant', 'staticProperty', 'property', 'constructor', 'method'] as const;

type Group = (typeof GROUPS)[number];

/** Public API first: what a reader of the class is looking for is what it offers. */
const VISIBILITY_ORDER: Record<Visibility, number> = { public: 0, protected: 1, private: 2 };

/** One member, with everything written above it that belongs to it. */
interface SortableMember {
  start: number;
  end: number;
  rank: number;
  text: string;
}

function previousLine(text: string, start: number): { start: number; end: number } | null {
  if (start === 0) {
    return null;
  }

  return { start: lineStartOf(text, start - 1), end: start - 1 };
}

/**
 * Where a member really starts: a docblock and the attributes above it are part of it, and
 * leaving them behind would attach them to whichever member the sort moves up.
 */
function memberStart(text: string, declaration: number): number {
  let start = lineStartOf(text, docblockStart(text, declaration));

  // Attributes are written above the docblock as often as below it, so both are walked here.
  for (;;) {
    const previous = previousLine(text, start);

    if (!previous) {
      return start;
    }

    const written = text.slice(previous.start, previous.end).trim();

    if (written.startsWith('#[')) {
      start = previous.start;
      continue;
    }

    if (written.endsWith('*/')) {
      const opening = text.lastIndexOf('/**', previous.end);

      if (opening === -1) {
        return start;
      }

      start = lineStartOf(text, opening);
      continue;
    }

    return start;
  }
}

/** Walks past the semicolon a property or constant ends with, which the parser leaves out. */
function memberEnd(text: string, end: number): number {
  const semicolon = text.indexOf(';', end);

  return semicolon === -1 || text.slice(end, semicolon).trim() !== '' ? end : semicolon + 1;
}

function rankOf(group: Group, visibility: Visibility): number {
  return GROUPS.indexOf(group) * 10 + VISIBILITY_ORDER[visibility];
}

/**
 * The members of the class, each with the rank its group and visibility give it.
 *
 * Promoted constructor parameters are declared as properties too, but they live inside the
 * constructor and cannot be moved on their own, so they are read out of the list here.
 */
function membersOf(text: string, parsed: ParsedFile, declaration: Declaration): SortableMember[] {
  const owned = <T extends { className: string; start: number }>(members: T[]): T[] =>
    members.filter((member) => member.className === declaration.fqn && member.start >= declaration.bodyStart);
  const methods = owned(parsed.methods);
  const isPromoted = (start: number): boolean =>
    methods.some((method) => start > method.start && start < method.end);

  const found: { start: number; end: number; rank: number }[] = [
    ...owned(parsed.constants).map((constant) => ({
      start: constant.start,
      end: constant.end,
      rank: rankOf('constant', constant.visibility),
    })),
    ...owned(parsed.properties)
      .filter((property) => !isPromoted(property.start))
      .map((property) => ({
        start: property.start,
        end: property.end,
        rank: rankOf(property.isStatic ? 'staticProperty' : 'property', property.visibility),
      })),
    ...methods.map((method) => ({
      start: method.start,
      end: method.end,
      rank:
        method.name === '__construct'
          ? rankOf('constructor', 'public')
          : rankOf('method', method.visibility),
    })),
  ];

  return found
    .sort((first, second) => first.start - second.start)
    .map((member) => {
      const start = memberStart(text, member.start);
      const end = memberEnd(text, member.end);

      return { start, end, rank: member.rank, text: text.slice(start, end) };
    });
}

/**
 * True when nothing but blank lines sit between the members.
 *
 * A trait import or a loose comment written between two of them has no member to travel
 * with, so rewriting the body as a list of members would drop it.
 */
function isOnlyMembers(text: string, members: SortableMember[]): boolean {
  return members.every((member, index) => {
    const previous = members[index - 1];

    return index === 0 || text.slice(previous.end, member.start).trim() === '';
  });
}

/** The body rewritten in order, or null when it is already in it. */
function sortedBody(members: SortableMember[]): string | null {
  // A stable sort keeps members of the same rank in the order they were written, which is
  // the only thing telling a reader why they sit next to each other.
  const sorted = [...members].sort((first, second) => first.rank - second.rank);

  if (sorted.every((member, index) => member === members[index])) {
    return null;
  }

  return sorted.map((member) => member.text.trimEnd()).join('\n\n');
}

/**
 * The class body rewritten in order: constants, then properties, then the constructor, then
 * the methods, each group public first.
 */
export function planSortMembers(text: string, parsed: ParsedFile, declaration: Declaration): Planned {
  const members = membersOf(text, parsed, declaration);

  if (members.length < 2) {
    return { error: `${declaration.name} has nothing to reorder.` };
  }

  if (!isOnlyMembers(text, members)) {
    return {
      error: `${declaration.name} has code written between its members; reordering it would move that code out of place.`,
    };
  }

  const body = sortedBody(members);

  if (body === null) {
    return { error: `${declaration.name} is already in order.` };
  }

  return {
    edits: [{ start: members[0].start, end: members[members.length - 1].end, text: body }],
    summary: `${declaration.name} — ${members.length} members reordered.`,
  };
}

/** Rearranges the members of the class the cursor sits in. */
export async function sortMembers(): Promise<void> {
  const target = activeTarget();

  if (!target) {
    return;
  }

  const file = indexedFile(target.document.uri, target.text);
  const declaration = classAt(file.parsed, target.selection.start);

  if (!declaration) {
    vscode.window.showWarningMessage('Place the cursor inside a class.');
    return;
  }

  await applyPlan(target.document, planSortMembers(file.text, file.parsed, declaration));
}
