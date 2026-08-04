import { describe, expect, test } from 'bun:test';
import { foldingRanges } from '../src/php/folding';
import { enclosingSpans, stringContentAt } from '../src/php/spans';

const FILE = `<?php

namespace App\\Jobs;

use App\\Models\\Customer;
use App\\Models\\Site;

/**
 * Vérifie qu'une boutique répond.
 */
final class CheckSiteReadinessJob
{
    // Deux lignes de commentaire
    // qui se suivent.
    public function handle(): void
    {
        $site->update([
            'status' => SiteStatus::ONLINE,
        ]);
    }
}
`;

/** The fold covering the given line, if any. */
function foldAt(text: string, line: number): string {
  const range = foldingRanges(text).find((candidate) => candidate.startLine === line);

  return range ? `${range.kind} ${range.startLine}-${range.endLine}` : '(rien)';
}

describe('folding a PHP file', () => {
  const lines = FILE.split('\n');
  const lineOf = (needle: string): number => lines.findIndex((line) => line.includes(needle));

  test('folds the run of use declarations', () => {
    expect(foldAt(FILE, lineOf('use App\\Models\\Customer'))).toBe('imports 4-5');
  });

  test('folds a docblock and a run of line comments', () => {
    expect(foldAt(FILE, lineOf('/**'))).toStartWith('comment');
    expect(foldAt(FILE, lineOf('// Deux lignes'))).toStartWith('comment');
  });

  test('folds the class and the method, closing brace left visible', () => {
    const classFold = foldingRanges(FILE).find(
      (range) => range.startLine === lineOf('final class') && range.kind === 'block',
    );

    expect(classFold?.endLine).toBe(lines.length - 3);
  });

  test('folds a heredoc on its own', () => {
    const source = ['<?php', '$query = <<<SQL', '    select 1', '    from dual', 'SQL;', ''].join('\n');

    expect(foldAt(source, 1)).toBe('block 1-3');
  });

  test('folds a region', () => {
    const source = ['<?php', '# region Boot', '$a = 1;', '# endregion', ''].join('\n');

    expect(foldAt(source, 1)).toBe('region 1-3');
  });

  test('offers nothing for a single-line body', () => {
    expect(foldingRanges(`<?php\nfunction f() { return 1; }\n`)).toEqual([]);
  });
});

describe('growing a selection', () => {
  const CALL = `<?php\n$site->update(['status' => 'online']);\n`;

  test('stops inside the quotes first, then widens step by step', () => {
    const offset = CALL.indexOf('online') + 2;
    const content = stringContentAt(CALL, offset);

    expect(CALL.slice(content?.start, content?.end)).toBe('online');

    const widening = enclosingSpans(CALL, offset).map((span) => CALL.slice(span.start, span.end));

    expect(widening[0]).toBe("'online'");
    expect(widening).toContain("['status' => 'online']");
    expect(widening[widening.length - 1]).toContain('$site->update(');
  });

  test('each step is strictly wider than the one before', () => {
    const spans = enclosingSpans(CALL, CALL.indexOf('status'));

    spans.forEach((span, index) => {
      const previous = spans[index - 1];

      if (previous) {
        expect(span.end - span.start).toBeGreaterThan(previous.end - previous.start);
      }
    });
  });

  test('says nothing about a file it cannot parse', () => {
    expect(enclosingSpans('', 0)).toEqual([]);
  });
});
