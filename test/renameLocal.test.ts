import { describe, expect, test } from 'bun:test';
import { planRenameLocal } from '../src/refactor/renameLocal';
import { applyTextEdits, isRefused } from '../src/refactor/plan';

function rename(text: string, cursorOn: string, newName: string): string {
  const plan = planRenameLocal(text, text.indexOf(cursorOn) + 1, newName);

  if (isRefused(plan)) {
    throw new Error(plan.error);
  }

  return applyTextEdits(text, plan.edits);
}

function refusal(text: string, cursorOn: string, newName: string): string {
  const plan = planRenameLocal(text, text.indexOf(cursorOn) + 1, newName);

  return isRefused(plan) ? plan.error : '';
}

describe('renaming a local variable', () => {
  const source = `<?php

function total(int $price): int
{
    $count = 2;
    $result = $price * $count;

    return $result + $count;
}
`;

  test('renames every mention inside the function', () => {
    const renamed = rename(source, '$count = 2', 'quantity');

    expect(renamed).toContain('$quantity = 2;');
    expect(renamed).toContain('$result = $price * $quantity;');
    expect(renamed).toContain('return $result + $quantity;');
    expect(renamed).not.toContain('$count');
  });

  test('renames a parameter in its declaration and its uses', () => {
    const renamed = rename(source, '$price)', 'amount');

    expect(renamed).toContain('function total(int $amount): int');
    expect(renamed).toContain('$result = $amount * $count;');
  });

  test('refuses a name the scope already uses', () => {
    expect(refusal(source, '$count = 2', 'result')).toBe('$result is already used here.');
  });

  test('refuses anything that is not a variable', () => {
    expect(refusal(source, 'function total', 'x')).toBe('Place the cursor on a local variable or a parameter.');
  });
});

describe('renaming a captured variable', () => {
  const source = `<?php

function report(array $rows): callable
{
    $total = 0;
    $add = function (int $row) use (&$total): void {
        $total += $row;
    };
    $double = fn (int $row): int => $row * $total;

    return $add;
}
`;

  test('follows the variable into the closure that captures it', () => {
    const renamed = rename(source, '$total = 0', 'sum');

    expect(renamed).toContain('$sum = 0;');
    expect(renamed).toContain('use (&$sum)');
    expect(renamed).toContain('$sum += $row;');
    expect(renamed).toContain('=> $row * $sum;');
  });

  test('renames the whole variable when the cursor is inside the closure', () => {
    const renamed = rename(source, '$total += $row', 'sum');

    expect(renamed).toContain('$sum = 0;');
    expect(renamed).toContain('use (&$sum)');
    expect(renamed).toContain('$sum += $row;');
  });

  test('keeps the parameter of the closure separate from the one of the arrow function', () => {
    const renamed = rename(source, '$row) use', 'line');

    expect(renamed).toContain('function (int $line) use (&$total)');
    expect(renamed).toContain('$total += $line;');
    expect(renamed).toContain('fn (int $row): int => $row * $total;');
  });
});

describe('renaming a variable mentioned in strings', () => {
  const source = `<?php

function label(string $shop): string
{
    $heredoc = <<<TXT
    open $shop and {$shop}
    TXT;
    $nowdoc = <<<'TXT'
    keep $shop as is
    TXT;

    return "value $shop end" . 'plain $shop' . $heredoc . $nowdoc;
}
`;

  test('renames interpolations but leaves single-quoted and nowdoc text alone', () => {
    const renamed = rename(source, '$shop)', 'store');

    expect(renamed).toContain('function label(string $store): string');
    expect(renamed).toContain('open $store and {$store}');
    expect(renamed).toContain('keep $shop as is');
    expect(renamed).toContain('"value $store end"');
    expect(renamed).toContain("'plain $shop'");
  });
});

describe('renaming a variable a runtime name may reach', () => {
  test('warns when the scope uses compact', () => {
    const source = `<?php

function show(int $total): array
{
    return compact('total');
}
`;
    const plan = planRenameLocal(source, source.indexOf('$total)') + 1, 'amount');

    expect(isRefused(plan)).toBe(false);
    expect(isRefused(plan) ? '' : plan.warning).toContain('compact');
  });
});
