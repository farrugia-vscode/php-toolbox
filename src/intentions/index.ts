import { nodeChain } from '../php/nodeIndex';
import type { TextEdit } from '../refactor/editSet';
import { indentAt, indentUnit } from '../refactor/textLayout';
import { negate } from './negation';
import { textOf } from './nodeText';
import { promoteParameter } from './promoteParameter';
import {
  concatToInterpolation,
  concatToSprintf,
  interpolationToConcat,
  interpolationToSprintf,
} from './stringForms';

/** A small, local rewrite offered where the cursor already is. */
export interface Intention {
  title: string;
  edits: TextEdit[];
}

type Finder = (text: string, chain: any[], offset: number) => Intention | null;

/** Moves a block one level to the left, for code that loses a nesting level. */
function dedent(block: string, unit: string): string {
  return block
    .split('\n')
    .map((line, index) => (index === 0 || !line.startsWith(unit) ? line : line.slice(unit.length)))
    .join('\n');
}

function indent(block: string, unit: string): string {
  return block
    .split('\n')
    .map((line, index) => (index === 0 || line.trim() === '' ? line : `${unit}${line}`))
    .join('\n');
}

/** `if (…) { … } else { … }` reads better one way round than the other. */
const invertIf: Finder = (text, chain) => {
  const node = chain.find((candidate) => candidate.kind === 'if');

  if (!node?.alternate || node.alternate.kind === 'if' || !node.body?.loc) {
    return null;
  }

  return {
    title: 'Invert if condition',
    edits: [
      { start: node.test.loc.start.offset, end: node.test.loc.end.offset, text: negate(node.test, text) },
      { start: node.body.loc.start.offset, end: node.body.loc.end.offset, text: textOf(text, node.alternate) },
      { start: node.alternate.loc.start.offset, end: node.alternate.loc.end.offset, text: textOf(text, node.body) },
    ],
  };
};

/** Two conditions, one nesting level: `if (a) { if (b) { … } }`. */
const mergeNestedIf: Finder = (text, chain) => {
  const outer = chain.find((candidate) => candidate.kind === 'if');
  const inner = outer?.body?.children?.length === 1 ? outer.body.children[0] : null;

  if (!outer || outer.alternate || inner?.kind !== 'if' || inner.alternate) {
    return null;
  }

  const unit = indentUnit(text);

  return {
    title: 'Merge with the nested if',
    edits: [
      {
        start: outer.test.loc.end.offset,
        end: outer.test.loc.end.offset,
        text: ` && ${textOf(text, inner.test)}`,
      },
      {
        start: outer.body.loc.start.offset,
        end: outer.body.loc.end.offset,
        text: dedent(textOf(text, inner.body), unit),
      },
    ],
  };
};

/** The other way round: a long `&&` condition becomes two readable ifs. */
const splitIf: Finder = (text, chain) => {
  const node = chain.find((candidate) => candidate.kind === 'if');

  if (!node || node.alternate || node.test?.kind !== 'bin' || node.test.type !== '&&' || !node.body?.loc) {
    return null;
  }

  const unit = indentUnit(text);
  const outerIndent = indentAt(text, node.loc.start.offset);
  const body = indent(textOf(text, node.body), unit);

  return {
    title: 'Split into two ifs',
    edits: [
      {
        start: node.loc.start.offset,
        end: node.loc.end.offset,
        text: [
          `if (${textOf(text, node.test.left)}) {`,
          `${outerIndent}${unit}if (${textOf(text, node.test.right)}) ${body}`,
          `${outerIndent}}`,
        ].join('\n'),
      },
    ],
  };
};

/** A closure whose whole body is a `return` is an arrow function waiting to happen. */
const closureToArrow: Finder = (text, chain) => {
  const node = chain.find((candidate) => candidate.kind === 'closure');
  const statements = node?.body?.children ?? [];
  const returned = statements.length === 1 && statements[0].kind === 'return' ? statements[0].expr : null;

  if (!node || !returned || (node.uses ?? []).some((used: any) => used.byref)) {
    return null;
  }

  const params = (node.arguments ?? []).map((argument: any) => textOf(text, argument)).join(', ');
  const modifier = node.isStatic ? 'static ' : '';
  const returnType = node.type ? `: ${textOf(text, node.type)}` : '';

  return {
    title: 'Convert to arrow function',
    edits: [
      {
        start: node.loc.start.offset,
        end: node.loc.end.offset,
        text: `${modifier}fn (${params})${returnType} => ${textOf(text, returned)}`,
      },
    ],
  };
};

/** Nothing else in the file says the types are enforced. */
const addStrictTypes: Finder = (text, _chain, offset) => {
  const open = text.indexOf('<?php');

  if (open === -1 || /declare\s*\(\s*strict_types/.test(text) || offset > open + 200) {
    return null;
  }

  const anchor = open + '<?php'.length;

  return {
    title: 'Add declare(strict_types=1)',
    edits: [{ start: anchor, end: anchor, text: '\n\ndeclare(strict_types=1);' }],
  };
};

const FINDERS: Finder[] = [
  invertIf,
  mergeNestedIf,
  splitIf,
  closureToArrow,
  concatToInterpolation,
  concatToSprintf,
  interpolationToConcat,
  interpolationToSprintf,
  addStrictTypes,
  (text, _chain, offset) => promoteParameter(text, offset),
];

/**
 * The rewrites that apply where the cursor is.
 *
 * They carry their edits with them: these are small enough to be applied straight from the
 * menu, without a command asking anything.
 */
export function intentionsAt(text: string, offset: number): Intention[] {
  const chain = nodeChain(text, offset);

  return FINDERS.map((finder) => finder(text, chain, offset)).filter((found): found is Intention => found !== null);
}
