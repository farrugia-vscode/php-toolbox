import { describe, expect, test } from 'bun:test';
import { planExtractMethod } from '../src/refactor/extractMethod';
import { applyTextEdits, isRefused } from '../src/refactor/plan';

const INVOICE = `<?php

namespace App;

final class Invoice
{
    public function total(array $lines, float $taxRate): float
    {
        $subtotal = 0;
        foreach ($lines as $line) {
            $subtotal += $line['price'] * $line['quantity'];
        }

        $tax = $subtotal * $taxRate;

        return $subtotal + $tax;
    }
}
`;

function extract(text: string, selection: { start: number; end: number }, name: string) {
  const plan = planExtractMethod(text, selection, name);

  if (isRefused(plan)) {
    return { error: plan.error, result: '', plan: null };
  }

  return { error: null, result: applyTextEdits(text, plan.edits), plan };
}

describe('extracting a method', () => {
  test('passes what the selection reads and returns what the rest of the method needs', () => {
    const start = INVOICE.indexOf('$subtotal = 0;');
    const end = INVOICE.indexOf('        }\n\n        $tax') + '        }'.length;
    const { result, plan } = extract(INVOICE, { start, end }, 'sumLines');

    expect(plan?.parameters).toEqual(['lines']);
    expect(plan?.returned).toEqual(['subtotal']);
    expect(result).toContain('        $subtotal = $this->sumLines($lines);');
    expect(result).toContain('    private function sumLines(array $lines)');
    expect(result).toContain('        return $subtotal;');
  });

  test('keeps the body indented like the code it came from', () => {
    const start = INVOICE.indexOf('$subtotal = 0;');
    const end = INVOICE.indexOf('        }\n\n        $tax') + '        }'.length;
    const { result } = extract(INVOICE, { start, end }, 'sumLines');

    expect(result).toContain('        $subtotal = 0;\n        foreach ($lines as $line) {\n            $subtotal +=');
  });

  test('lets the caller return when the selection runs to the end of the method', () => {
    const start = INVOICE.indexOf('$tax = $subtotal');
    const end = INVOICE.indexOf('return $subtotal + $tax;') + 'return $subtotal + $tax;'.length;
    const { result, plan } = extract(INVOICE, { start, end }, 'withTax');

    expect(plan?.parameters).toEqual(['subtotal', 'taxRate']);
    expect(result).toContain('        return $this->withTax($subtotal, $taxRate);');
    expect(result).toContain('    private function withTax($subtotal, float $taxRate): float');
  });

  test('refuses a selection that returns from the middle of the method', () => {
    const source = INVOICE.replace('$tax = $subtotal * $taxRate;', 'if ($taxRate === 0.0) {\n            return $subtotal;\n        }');
    const start = source.indexOf('if ($taxRate');
    const end = source.indexOf('        }\n\n        return') + '        }'.length;

    expect(extract(source, { start, end }, 'shortcut').error).toBe(
      'The selection returns from the middle of the method.',
    );
  });

  test('refuses a name the class already uses', () => {
    const start = INVOICE.indexOf('$subtotal = 0;');
    const end = start + '$subtotal = 0;'.length;

    expect(extract(INVOICE, { start, end }, 'total').error).toContain('already has a method named total');
  });

  test('grows a partial selection to the statements it touches', () => {
    const start = INVOICE.indexOf('subtotal = 0');
    const end = start + 3;
    const { result } = extract(INVOICE, { start, end }, 'startAt');

    expect(result).toContain('        $subtotal = $this->startAt();');
    expect(result).toContain('    private function startAt()\n    {\n        $subtotal = 0;\n        return $subtotal;\n    }');
  });
});
