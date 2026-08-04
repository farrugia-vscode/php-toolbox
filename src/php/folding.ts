import { parseAst } from './engine';

export type FoldKind = 'region' | 'comment' | 'imports' | 'block';

/** A foldable stretch of lines, both ends included and zero-based. */
export interface FoldRange {
  startLine: number;
  endLine: number;
  kind: FoldKind;
}

/** Nodes worth a fold marker: anything that owns a body written over several lines. */
const FOLDABLE = new Set([
  'class',
  'interface',
  'trait',
  'enum',
  'function',
  'method',
  'closure',
  'arrowfunc',
  'if',
  'for',
  'foreach',
  'while',
  'do',
  'switch',
  'try',
  'match',
  'array',
  'call',
  'new',
]);

function pushRange(ranges: FoldRange[], startLine: number, endLine: number, kind: FoldKind): void {
  // A fold that hides nothing is noise in the gutter.
  if (endLine > startLine) {
    ranges.push({ startLine, endLine, kind });
  }
}

/** Declarations, blocks and multi-line literals, read off the syntax tree. */
function syntaxRanges(text: string): FoldRange[] {
  const ast = parseAst(text);

  if (!ast) {
    return [];
  }

  const ranges: FoldRange[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.loc && FOLDABLE.has(node.kind)) {
      // The last line carries the closing brace or bracket, which has to stay visible.
      pushRange(ranges, node.loc.start.line - 1, node.loc.end.line - 2, 'block');
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

  return ranges;
}

/** `// …` runs, `/* … *​/` blocks, heredocs and `#region` markers, read line by line. */
function textualRanges(lines: string[]): FoldRange[] {
  const ranges: FoldRange[] = [];
  const regions: number[] = [];
  let commentStart: number | null = null;
  let blockStart: number | null = null;
  let heredocStart: number | null = null;
  let heredocLabel: string | null = null;
  let importStart: number | null = null;

  const closeComments = (line: number): void => {
    if (commentStart !== null) {
      pushRange(ranges, commentStart, line - 1, 'comment');
      commentStart = null;
    }
  };

  const closeImports = (line: number): void => {
    if (importStart !== null) {
      pushRange(ranges, importStart, line - 1, 'imports');
      importStart = null;
    }
  };

  lines.forEach((raw, line) => {
    const trimmed = raw.trim();

    if (heredocLabel !== null) {
      if (new RegExp(`^\\s*${heredocLabel}\\s*[;,)]?$`).test(raw)) {
        pushRange(ranges, heredocStart as number, line - 1, 'block');
        heredocLabel = null;
        heredocStart = null;
      }
      return;
    }

    const heredoc = /<<<\s*["']?(\w+)["']?\s*$/.exec(trimmed);

    if (heredoc) {
      heredocStart = line;
      heredocLabel = heredoc[1];
      return;
    }

    if (blockStart !== null) {
      if (trimmed.includes('*/')) {
        pushRange(ranges, blockStart, line, 'comment');
        blockStart = null;
      }
      return;
    }

    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) {
        blockStart = line;
      }
      return;
    }

    if (/^#\s*region\b/.test(trimmed)) {
      closeComments(line);
      regions.push(line);
      return;
    }

    if (/^#\s*endregion\b/.test(trimmed)) {
      const opened = regions.pop();

      if (opened !== undefined) {
        pushRange(ranges, opened, line, 'region');
      }
      return;
    }

    if (trimmed.startsWith('//')) {
      commentStart = commentStart ?? line;
      return;
    }

    closeComments(line);

    if (/^use\s+[\w\\]/.test(trimmed)) {
      importStart = importStart ?? line;
      return;
    }

    closeImports(line);
  });

  closeComments(lines.length);
  closeImports(lines.length);

  return ranges;
}

/**
 * Every fold a PHP file offers. Indentation alone gets the common cases wrong: a docblock,
 * a run of `use` lines and a heredoc all sit at the same level as the code around them.
 */
export function foldingRanges(text: string): FoldRange[] {
  const ranges = [...syntaxRanges(text), ...textualRanges(text.split('\n'))];
  const seen = new Set<string>();

  return ranges.filter((range) => {
    const key = `${range.startLine}:${range.endLine}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
