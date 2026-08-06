import { describe, expect, test } from 'bun:test';
import { parseFile } from '../src/php/parser';
import { applyTextEdits } from '../src/refactor/plan';
import { copyTypeEdits } from '../src/refactor/copyType';

const ORDER = `<?php

namespace App\\Billing;

use App\\Support\\Money;

final class Order
{
    public const SOURCE = Order::class;

    public static function empty(): Order
    {
        return new Order(new Money(0));
    }

    public function __construct(private readonly Money $total) {}
}
`;

function copy(text: string, oldFqn: string, newFqn: string): string {
  return applyTextEdits(text, copyTypeEdits(parseFile(text), text, oldFqn, newFqn));
}

describe('copying a type', () => {
  test('renames the declaration and every mention the file makes of itself', () => {
    const result = copy(ORDER, 'App\\Billing\\Order', 'App\\Billing\\DraftOrder');

    expect(result).toContain('final class DraftOrder');
    expect(result).toContain('public const SOURCE = DraftOrder::class;');
    expect(result).toContain('public static function empty(): DraftOrder');
    expect(result).toContain('return new DraftOrder(new Money(0));');
    // Word boundary: `DraftOrder` must not be mistaken for a leftover `Order`.
    expect(result).not.toMatch(/\bOrder\b/);
  });

  test('rewrites the namespace when the copy lands somewhere else', () => {
    const result = copy(ORDER, 'App\\Billing\\Order', 'App\\Quotes\\Draft');

    expect(result).toContain('namespace App\\Quotes;');
    expect(result).toContain('final class Draft');
  });

  test('keeps the namespace line untouched when only the name changes', () => {
    const result = copy(ORDER, 'App\\Billing\\Order', 'App\\Billing\\DraftOrder');

    expect(result).toContain('namespace App\\Billing;');
  });

  test('leaves the imports of other types alone', () => {
    const result = copy(ORDER, 'App\\Billing\\Order', 'App\\Quotes\\Draft');

    expect(result).toContain('use App\\Support\\Money;');
    expect(result).toContain('private readonly Money $total');
  });

  test('follows the type inside a class-string', () => {
    const text = `<?php

namespace App\\Billing;

final class Order
{
    public const JOB = 'App\\\\Billing\\\\Order';
}
`;

    expect(copy(text, 'App\\Billing\\Order', 'App\\Billing\\DraftOrder')).toContain(
      "'App\\\\Billing\\\\DraftOrder'",
    );
  });
});
