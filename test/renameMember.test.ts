import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';
import { applyEdits, Uri } from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Billing/Invoice.php',
    `<?php

namespace App\\Billing;

class Invoice
{
    public const STATUS_PAID = 'paid';

    public function __construct(private int $amount)
    {
    }

    public function total(): int
    {
        return $this->amount;
    }

    public function isPaid(): bool
    {
        return self::STATUS_PAID === $this->status;
    }
}
`,
  ],
  [
    'file:///p/app/Billing/Refund.php',
    `<?php

namespace App\\Billing;

final class Refund extends Invoice
{
    public function total(): int
    {
        return -1 * parent::total();
    }
}
`,
  ],
  [
    'file:///p/app/Billing/InvoiceFactory.php',
    `<?php

namespace App\\Billing;

final class InvoiceFactory
{
    public function named(): Invoice
    {
        return new Invoice(amount: 500);
    }

    public function positional(): Invoice
    {
        return new Invoice(500);
    }
}
`,
  ],
  [
    'file:///p/app/Http/Controllers/InvoiceController.php',
    `<?php

namespace App\\Http\\Controllers;

use App\\Billing\\Invoice;

final class InvoiceController
{
    public function show(Invoice $invoice): array
    {
        return ['total' => $invoice->total(), 'status' => Invoice::STATUS_PAID];
    }
}
`,
  ],
]);

mock.module('vscode', () => vscodeStub);
mock.module('../src/workspaceIndex', () => ({
  getIndex: async () => files,
  onDidChangeFile: () => {},
  warmIndex: () => {},
}));

const { indexedFile } = await import('../src/php/phpIndex');
const { buildMemberRename, memberAtCursor } = await import('../src/refactor/renameMember');

const INVOICE = 'file:///p/app/Billing/Invoice.php';

async function rename(uri: string, cursorOn: string, newName: string) {
  const text = files.get(uri)!;
  const file = indexedFile(Uri.parse(uri) as never, text);
  const target = await memberAtCursor(file, text.indexOf(cursorOn) + 1);

  if (!target) {
    return { target: null, results: new Map<string, string>() };
  }

  const { edit } = await buildMemberRename(target, newName);
  const results = new Map<string, string>();

  (edit as unknown as vscodeStub.WorkspaceEdit).entries().forEach(([uriOf, edits]) => {
    results.set(uriOf.path, applyEdits(files.get(uriOf.toString()) ?? '', edits));
  });

  return { target, results };
}

describe('renaming a method', () => {
  test('renames the declaration, the override and every call', async () => {
    const { results } = await rename(INVOICE, 'total(): int', 'amountDue');

    expect(results.get('/p/app/Billing/Invoice.php')).toContain('public function amountDue(): int');
    expect(results.get('/p/app/Billing/Refund.php')).toContain('public function amountDue(): int');
    expect(results.get('/p/app/Billing/Refund.php')).toContain('parent::amountDue()');
    expect(results.get('/p/app/Http/Controllers/InvoiceController.php')).toContain('$invoice->amountDue()');
  });

  test('works from a call as well as from the declaration', async () => {
    const { target } = await rename('file:///p/app/Http/Controllers/InvoiceController.php', 'total()', 'amountDue');

    expect(target).toMatchObject({ kind: 'method', name: 'total', className: 'App\\Billing\\Invoice' });
  });
});

describe('renaming a promoted property', () => {
  test('renames the parameter and every read of the property', async () => {
    const { results } = await rename(INVOICE, 'amount)', 'total');

    expect(results.get('/p/app/Billing/Invoice.php')).toContain('private int $total');
    expect(results.get('/p/app/Billing/Invoice.php')).toContain('return $this->total;');
  });

  test('follows the named arguments that build the class, and leaves positional values alone', async () => {
    const { results } = await rename(INVOICE, 'amount)', 'total');
    const factory = results.get('/p/app/Billing/InvoiceFactory.php') ?? '';

    expect(factory).toContain('new Invoice(total: 500)');
    expect(factory).toContain('new Invoice(500)');
  });

  test('is found with the cursor on the `$` of the name, where a click lands', async () => {
    const text = files.get(INVOICE)!;
    const file = indexedFile(Uri.parse(INVOICE) as never, text);
    const target = await memberAtCursor(file, text.indexOf('$amount)'));

    expect(target).toMatchObject({ kind: 'property', name: 'amount' });
  });
});

describe('renaming a constant', () => {
  test('renames it where it is declared and where it is read', async () => {
    const { results } = await rename(INVOICE, 'STATUS_PAID', 'PAID');

    expect(results.get('/p/app/Billing/Invoice.php')).toContain('public const PAID');
    expect(results.get('/p/app/Billing/Invoice.php')).toContain('self::PAID ===');
    expect(results.get('/p/app/Http/Controllers/InvoiceController.php')).toContain('Invoice::PAID');
  });
});

describe('renaming a promoted property', () => {
  test('renames the constructor parameter along with the property', async () => {
    const { results } = await rename(INVOICE, 'amount)', 'cents');
    const invoice = results.get('/p/app/Billing/Invoice.php') ?? '';

    expect(invoice).toContain('private int $cents');
    expect(invoice).toContain('return $this->cents;');
  });
});
