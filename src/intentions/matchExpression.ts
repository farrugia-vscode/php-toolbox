import type { Intention } from '.';
import { indentAt, indentUnit } from '../refactor/textLayout';
import { textOf } from './nodeText';

/** What every branch does with its value, which is what decides where the match goes. */
type Outcome = { kind: 'return' } | { kind: 'assign'; target: string };

/** One arm of the match: the values it answers to, or null for `default`. */
interface Arm {
  values: string[] | null;
  result: string;
}

/** One branch of the chain being read, before we know it can become an arm. */
interface Branch {
  /** The values the branch answers to, or null for `else` and `default`. */
  tests: any[] | null;
  statements: any[];
}

/** `break` carries no value: it only exists because a switch falls through without it. */
function valueStatements(statements: any[]): any[] {
  return statements.filter((statement) => statement.kind !== 'break');
}

/** The single value a branch produces, and how it produces it. */
function resultOf(branch: Branch, text: string): { outcome: Outcome; result: string } | null {
  const statements = valueStatements(branch.statements);

  if (statements.length !== 1) {
    return null;
  }

  const [only] = statements;

  if (only.kind === 'return' && only.expr) {
    return { outcome: { kind: 'return' }, result: textOf(text, only.expr) };
  }

  const assigned = only.kind === 'expressionstatement' ? only.expression : null;

  // A compound assignment reads the variable before writing it, so the arms are not independent.
  if (assigned?.kind !== 'assign' || assigned.operator !== '=') {
    return null;
  }

  return { outcome: { kind: 'assign', target: textOf(text, assigned.left) }, result: textOf(text, assigned.right) };
}

function sameOutcome(first: Outcome, second: Outcome): boolean {
  if (first.kind !== second.kind) {
    return false;
  }

  return first.kind !== 'assign' || second.kind !== 'assign' || first.target === second.target;
}

/** `$a || $b` written as the list of comparisons it is made of. */
function orParts(node: any): any[] {
  if (node?.kind === 'bin' && (node.type === '||' || node.type === 'or')) {
    return [...orParts(node.left), ...orParts(node.right)];
  }

  return [node];
}

const EQUALITY = new Set(['===', '==']);

/**
 * The one value every condition compares, when there is one: `match ($status)` reads far
 * better than `match (true)`, but only the second form is always correct.
 */
function commonSubject(branches: Branch[], text: string): string | null {
  const conditions = branches.flatMap((branch) => branch.tests ?? []).flatMap(orParts);
  const comparisons = conditions.filter((node) => node?.kind === 'bin' && EQUALITY.has(node.type));

  if (comparisons.length !== conditions.length || comparisons.length === 0) {
    return null;
  }

  const subject = textOf(text, comparisons[0].left).trim();
  const isShared = comparisons.every((node) => textOf(text, node.left).trim() === subject);

  return isShared ? subject : null;
}

/**
 * The arms, built from the branches: on a shared subject the compared values are what the
 * match lists, otherwise the conditions themselves are, under `match (true)`.
 */
function armsOf(branches: Branch[], results: string[], text: string, subject: string | null): Arm[] {
  const valuesOf = (tests: any[]): string[] =>
    subject === null
      ? tests.map((node) => textOf(text, node).trim())
      : tests.flatMap(orParts).map((node) => textOf(text, node.right ?? node).trim());

  return branches.map((branch, index) => ({
    values: branch.tests === null ? null : valuesOf(branch.tests),
    result: results[index],
  }));
}

function render(subject: string, arms: Arm[], outcome: Outcome, text: string, start: number): string {
  const indent = indentAt(text, start);
  const unit = indentUnit(text);
  const lines = arms.map((arm) => `${indent}${unit}${arm.values === null ? 'default' : arm.values.join(', ')} => ${arm.result},`);
  const opening = outcome.kind === 'return' ? 'return match' : `${outcome.target} = match`;

  return [`${opening} (${subject}) {`, ...lines, `${indent}};`].join('\n');
}

/**
 * The chain as a match, or null when the two would not behave the same.
 *
 * Every branch has to produce one value the same way, and the chain has to end on an `else`
 * or a `default`: a match with no arm for the value throws, where a chain that runs out of
 * branches simply does nothing.
 */
function intentionFor(branches: Branch[], node: any, text: string, forced: string | null): Intention | null {
  if (branches.length < 2 || branches[branches.length - 1].tests !== null) {
    return null;
  }

  const produced = branches.map((branch) => resultOf(branch, text));
  const first = produced[0];

  if (!first || produced.some((entry) => entry === null || !sameOutcome(entry.outcome, first.outcome))) {
    return null;
  }

  const results = produced.map((entry) => (entry as { result: string }).result);
  const subject = forced ?? commonSubject(branches, text);
  const arms = armsOf(branches, results, text, subject);

  return {
    title: 'Convert to match',
    edits: [
      {
        start: node.loc.start.offset,
        end: node.loc.end.offset,
        text: render(subject ?? 'true', arms, first.outcome, text, node.loc.start.offset),
      },
    ],
  };
}

/** The branches of an `if / elseif / else` chain, read from the outermost `if` down. */
function chainOf(node: any): Branch[] | null {
  const branches: Branch[] = [];
  let current = node;

  while (current) {
    if (!current.body?.children) {
      return null;
    }

    branches.push({ tests: [current.test], statements: current.body.children });

    const alternate = current.alternate;

    if (!alternate) {
      return branches;
    }

    if (alternate.kind === 'if') {
      current = alternate;
      continue;
    }

    if (!alternate.children) {
      return null;
    }

    branches.push({ tests: null, statements: alternate.children });

    return branches;
  }

  return branches;
}

/** An if/elseif/else that only picks a value is a match written the long way. */
export function ifToMatch(text: string, chain: any[], offset: number): Intention | null {
  const node = chain.find((candidate) => candidate.kind === 'if');

  // From the outermost `if` of the chain: an inner one holds only part of the branches.
  if (!node || chain.some((candidate) => candidate.kind === 'if' && candidate.alternate === node)) {
    return null;
  }

  // On the condition only, or every line of every branch would offer it.
  if (!node.test?.loc || offset > node.test.loc.end.offset) {
    return null;
  }

  const branches = chainOf(node);

  return branches ? intentionFor(branches, node, text, null) : null;
}

/** The branches of a switch, empty cases folded into the one they fall through to. */
function casesOf(node: any): Branch[] | null {
  const branches: Branch[] = [];
  let pending: any[] = [];

  for (const entry of node.body?.children ?? []) {
    if (entry.kind !== 'case') {
      return null;
    }

    const statements = entry.body?.children ?? [];

    if (statements.length === 0) {
      // An empty case shares the body of the next one: `case 1: case 2: …`.
      pending.push(entry.test);
      continue;
    }

    branches.push({
      tests: entry.test === null ? null : [...pending, entry.test].filter(Boolean),
      statements,
    });
    pending = [];
  }

  // A trailing empty case falls out of the switch, which no arm can express.
  return pending.length === 0 ? branches : null;
}

/**
 * A switch whose cases each pick a value, as a match.
 *
 * Cases are compared with `==` by PHP and with `===` by a match, so a switch mixing types
 * on purpose changes meaning here. Values written as literals of the same kind — which is
 * what a switch is almost always made of — behave the same either way.
 */
export function switchToMatch(text: string, chain: any[], offset: number): Intention | null {
  const node = chain.find((candidate) => candidate.kind === 'switch');

  if (!node?.test?.loc || offset > node.test.loc.end.offset) {
    return null;
  }

  const branches = casesOf(node);

  return branches ? intentionFor(branches, node, text, textOf(text, node.test).trim()) : null;
}
