import { describe, expect, test } from 'bun:test';
import { findAssignment, findParameterType } from '../src/php/assignments';

const JOB = `<?php

namespace App\\Jobs;

use App\\Models\\Site;

final class CheckSiteReadinessJob
{
    public function handle(): void
    {
        $site = Site::query()->firstWhere('customer_id', $this->customerId);
        $customer = $site->customer;
        $invoice = $customer->latestInvoice();
        $mailer = new Mailer();
        $total = 12;
        // CURSOR
    }
}
`;

/** What the given variable holds where the comment sits. */
function assigned(name: string): unknown {
  return findAssignment(JOB, name, JOB.indexOf('// CURSOR'));
}

describe('findAssignment', () => {
  test('reads a property the variable was assigned', () => {
    expect(assigned('customer')).toEqual({
      kind: 'member',
      receiver: { kind: 'variable', name: 'site' },
      name: 'customer',
    });
  });

  test('reads a method call the same way as a property', () => {
    expect(assigned('invoice')).toEqual({
      kind: 'member',
      receiver: { kind: 'variable', name: 'customer' },
      name: 'latestInvoice',
    });
  });

  test('reads an instantiation', () => {
    expect(assigned('mailer')).toEqual({ kind: 'instantiation', className: 'Mailer' });
  });

  test('says nothing about what it cannot type', () => {
    expect(assigned('site')).toBeNull();
    expect(assigned('total')).toBeNull();
    expect(assigned('unknown')).toBeNull();
  });

  test('ignores an assignment written after the cursor', () => {
    const source = `<?php\n$customer = $site->customer;\n`;

    expect(findAssignment(source, 'customer', source.indexOf('$customer'))).toBeNull();
  });

  test('keeps the closest assignment above the cursor', () => {
    const source = [
      '<?php',
      '$model = $site->customer;',
      '$model = $invoice->payer;',
      '// here',
    ].join('\n');

    expect(findAssignment(source, 'model', source.indexOf('// here'))).toEqual({
      kind: 'member',
      receiver: { kind: 'variable', name: 'invoice' },
      name: 'payer',
    });
  });

  test('reads a parameter type without any inference', () => {
    const source = [
      '<?php',
      'class A {',
      '    private function isReady(Customer $customer, int $count): bool',
      '    {',
      '        // here',
      '    }',
      '}',
    ].join('\n');

    expect(findParameterType(source, 'customer', source.indexOf('// here'))).toBe('Customer');
    expect(findParameterType(source, 'count', source.indexOf('// here'))).toBe('int');
    expect(findParameterType(source, 'missing', source.indexOf('// here'))).toBeNull();
  });

  test('a closure parameter shadows the method holding it', () => {
    const source = [
      '<?php',
      'class A {',
      '    function f(Site $model): void',
      '    {',
      '        $this->each(function (Invoice $model) {',
      '            // here',
      '        });',
      '    }',
      '}',
    ].join('\n');

    expect(findParameterType(source, 'model', source.indexOf('// here'))).toBe('Invoice');
  });

  test('reads a nullable parameter type', () => {
    const source = '<?php\nfunction f(?Customer $customer) { /* here */ }';

    expect(findParameterType(source, 'customer', source.indexOf('/* here */'))).toBe('Customer');
  });

  test('reads a member off $this', () => {
    const source = `<?php\nclass A { function f() { $site = $this->site; } }`;

    expect(findAssignment(source, 'site', source.length)).toEqual({
      kind: 'member',
      receiver: { kind: 'this' },
      name: 'site',
    });
  });
});
