import { describe, expect, test } from 'bun:test';
import { parseFile } from '../src/php/parser';
import { importEdit, typesUsedIn } from '../src/refactor/imports';
import { planExtractExpression } from '../src/refactor/extractExpression';
import { applyTextEdits, isRefused } from '../src/refactor/plan';

const SETTINGS = `<?php

namespace App;

use App\\Support\\Money;

final class Settings
{
    private const CURRENCY = 'EUR';

    public function price(): Money
    {
        return new Money(1000, 'EUR');
    }
}
`;

describe('adding a member to a class', () => {
  test('keeps a new property apart from the constants above it', () => {
    const start = SETTINGS.indexOf('1000');
    const plan = planExtractExpression(SETTINGS, { start, end: start + 4 }, 'amount', 'property');
    const result = isRefused(plan) ? '' : applyTextEdits(SETTINGS, plan.edits);

    expect(result).toContain("    private const CURRENCY = 'EUR';\n\n    private $amount = 1000;");
    expect(result).toContain('return new Money($this->amount, \'EUR\');');
  });

  test('adds a constant right under the ones already there', () => {
    const start = SETTINGS.indexOf("'EUR');") ;
    const plan = planExtractExpression(SETTINGS, { start, end: start + 5 }, 'DEFAULT_CURRENCY', 'constant');
    const result = isRefused(plan) ? '' : applyTextEdits(SETTINGS, plan.edits);

    expect(result).toContain("    private const CURRENCY = 'EUR';\n    private const DEFAULT_CURRENCY = 'EUR';");
  });
});

describe('carrying imports along', () => {
  test('lists only the types the destination does not already know', () => {
    const parsed = parseFile(SETTINGS);
    const file = { parsed, text: SETTINGS, uri: null as never, mapper: null as never };
    const types = typesUsedIn(file, { start: 0, end: SETTINGS.length });

    expect(importEdit(parsed, types)).toBeNull();
    expect(importEdit({ ...parsed, imports: [] }, types)?.text).toBe('use App\\Support\\Money;\n');
  });
});
