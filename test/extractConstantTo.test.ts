import { describe, expect, test } from 'bun:test';
import { parseFile } from '../src/php/parser';
import { memberInsertOffset, memberIndent, memberText } from '../src/refactor/classEdits';
import { sameOccurrences, targetExpression } from '../src/refactor/extractExpression';
import { importEdit } from '../src/refactor/imports';
import { applyTextEdits } from '../src/refactor/plan';
import { analyzeScopes, scopeAt } from '../src/php/scopes';

const ORDER = `<?php

namespace App\\Billing;

final class Order
{
    public function label(): string
    {
        return 'paid' . $this->reference;
    }

    public function isPaid(): bool
    {
        return $this->status === 'paid';
    }
}
`;

const STATUSES = `<?php

namespace App\\Support;

final class Status
{
    public const PENDING = 'pending';
}
`;

/** The same steps the command runs, without the pickers in between. */
function extractTo(source: string, host: string, code: string, name: string) {
  const scopes = analyzeScopes(source);
  const start = source.indexOf(code);
  const expression = targetExpression(source, { start, end: start + code.length }, scopes.expressions)!;
  const scope = scopeAt(scopes, expression.start, expression.end)!;
  const occurrences = sameOccurrences(source, scopes.expressions, expression, {
    start: scope.bodyStart,
    end: scope.bodyEnd,
  });

  const hostParsed = parseFile(host);
  const declaration = hostParsed.declarations[0];
  const anchor = memberInsertOffset(host, hostParsed, declaration, 'constant');
  const sourceParsed = parseFile(source);

  const sourceEdits = occurrences.map((occurrence) => ({
    start: occurrence.start,
    end: occurrence.end,
    text: `${declaration.name}::${name}`,
  }));
  const imports = importEdit(sourceParsed, [declaration.fqn]);

  return {
    source: applyTextEdits(source, imports ? [...sourceEdits, imports] : sourceEdits),
    host: applyTextEdits(host, [
      {
        start: anchor.offset,
        end: anchor.offset,
        text: memberText(
          `public const ${name} = ${source.slice(expression.start, expression.end)};`,
          memberIndent(host, hostParsed, declaration),
          anchor,
        ),
      },
    ]),
    occurrences: occurrences.length,
  };
}

describe('extracting a constant into another class', () => {
  test('writes the constant next to the ones already there', () => {
    const { host } = extractTo(ORDER, STATUSES, "'paid'", 'PAID');

    expect(host).toContain("    public const PENDING = 'pending';\n    public const PAID = 'paid';");
  });

  test('points the occurrence at the other class and imports it', () => {
    const { source, occurrences } = extractTo(ORDER, STATUSES, "'paid'", 'PAID');

    expect(source).toContain("return Status::PAID . $this->reference;");
    expect(source).toContain('use App\\Support\\Status;');
    expect(occurrences).toBe(1);
  });
});
