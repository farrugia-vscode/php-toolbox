import { describe, expect, test } from 'bun:test';
import { planExtractExpression, suggestName } from '../src/refactor/extractExpression';
import { applyTextEdits, isRefused } from '../src/refactor/plan';

const CART = `<?php

namespace App;

final class Cart
{
    public function total(array $lines): float
    {
        $total = 0.0;
        foreach ($lines as $line) {
            $total += $line['price'] * 1.2;
        }

        return round($total * 1.2, 2);
    }
}
`;

function extract(
  code: string,
  name: string,
  target: 'variable' | 'constant' | 'property',
  options: { isReplacingAll?: boolean } = {},
) {
  const start = CART.indexOf(code);
  const plan = planExtractExpression(CART, { start, end: start + code.length }, name, target, options);

  return isRefused(plan) ? { error: plan.error, result: '' } : { error: null, result: applyTextEdits(CART, plan.edits) };
}

describe('extracting an expression', () => {
  test('introduces a variable on the line above', () => {
    const { result } = extract("$line['price'] * 1.2", 'linePrice', 'variable');

    expect(result).toContain('            $linePrice = $line[\'price\'] * 1.2;\n            $total += $linePrice;');
  });

  test('introduces a constant and replaces every identical literal', () => {
    const { result } = extract('1.2', 'TAX_RATE', 'constant', { isReplacingAll: true });

    expect(result).toContain('    private const TAX_RATE = 1.2;');
    expect(result).toContain("$total += $line['price'] * self::TAX_RATE;");
    expect(result).toContain('return round($total * self::TAX_RATE, 2);');
  });

  test('refuses a constant made of anything but literals', () => {
    expect(extract('round($total * 1.2, 2)', 'TOTAL', 'constant').error).toBe(
      'Only an expression made of literals can become a constant.',
    );
  });

  test('assigns a computed property where the code used to compute it', () => {
    const { result } = extract('round($total * 1.2, 2)', 'rounded', 'property');

    expect(result).toContain('    private $rounded;');
    expect(result).toContain('        $this->rounded = round($total * 1.2, 2);\n        return $this->rounded;');
  });

  test('names the extraction after the code it replaces', () => {
    expect(suggestName('$order->customerName', 'variable')).toBe('customerName');
    expect(suggestName('$this->getTaxRate()', 'variable')).toBe('taxRate');
    expect(suggestName("'tax rate'", 'constant')).toBe('TAX_RATE');
  });
});
