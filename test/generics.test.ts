import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Models/Invoice.php',
    `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

/**
 * @method static \\App\\Builders\\InvoiceBuilder<static>|Invoice query()
 * @method static \\Database\\Factories\\InvoiceFactory factory($count = null, $state = [])
 */
final class Invoice extends Model
{
    public function settle(): void
    {
    }
}
`,
  ],
  [
    'file:///p/app/Models/Customer.php',
    `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Relations\\HasMany;

final class Customer extends Model
{
    /** @return HasMany<Invoice, $this> */
    public function invoices(): HasMany
    {
        return $this->hasMany(Invoice::class);
    }
}
`,
  ],
  [
    'file:///p/app/Builders/InvoiceBuilder.php',
    `<?php

namespace App\\Builders;

use App\\Models\\Invoice;
use Illuminate\\Database\\Eloquent\\Builder;

/** @extends Builder<Invoice> */
final class InvoiceBuilder extends Builder
{
    public function overdue(): self
    {
        return $this;
    }
}
`,
  ],
  [
    'file:///p/database/factories/InvoiceFactory.php',
    `<?php

namespace Database\\Factories;

use App\\Models\\Invoice;
use Illuminate\\Database\\Eloquent\\Factories\\Factory;

/** @extends Factory<Invoice> */
final class InvoiceFactory extends Factory
{
    public function paid(): static
    {
        return $this;
    }
}
`,
  ],
  [
    'file:///p/tests/InvoiceTest.php',
    `<?php

use App\\Models\\Customer;
use App\\Models\\Invoice;

function customer(): Customer
{
    return new Customer();
}

Invoice::query()->overdue()->first()->settle();
Invoice::factory()->paid()->count(2)->create()->settle();
customer()->invoices()->create([])->settle();
customer()->invoices()->overdue()->first()->settle();
customer()->invoices()->overdue()->sum('total')->settle();
`,
  ],
]);

mock.module('vscode', () => vscodeStub);
mock.module('../src/workspaceIndex', () => ({
  getIndex: async () => files,
  onDidChangeFile: () => {},
  warmIndex: () => {},
}));

const { createApi } = await import('../src/api');
const { findMemberSites } = await import('../src/refactor/callSites');

const BUILDER = 'Illuminate\\Database\\Eloquent\\Builder';
const FACTORY = 'Illuminate\\Database\\Eloquent\\Factories\\Factory';
const HAS_MANY = 'Illuminate\\Database\\Eloquent\\Relations\\HasMany';

const settle = { kind: 'method' as const, name: 'settle', className: 'App\\Models\\Invoice' };
const overdue = { kind: 'method' as const, name: 'overdue', className: 'App\\Builders\\InvoiceBuilder' };

const lineOf = (site: { file: { text: string }; nameStart: number }) =>
  site.file.text.slice(site.file.text.lastIndexOf('\n', site.nameStart) + 1, site.file.text.indexOf('\n', site.nameStart)).trim();

/** What a framework extension would say: builders, relations and factories are generic over their model. */
const framework = {
  typeOf: ({ owner, lineage, arguments: args, name }: { owner: string; lineage: string[]; arguments: string[]; name: string }) => {
    const kinds = [owner, ...lineage];
    const model = args[0] ?? null;

    if (kinds.includes(FACTORY)) {
      return name === 'create' ? model : name === 'count' ? `${owner}<${args.join(', ')}>` : null;
    }

    if (kinds.includes(HAS_MANY)) {
      return name === 'create' ? model : model === null ? null : `${model}::query()`;
    }

    if (kinds.includes(BUILDER)) {
      return name === 'first' ? model : null;
    }

    return null;
  },
};

describe('a chain generic over a model', () => {
  test('is read from @extends, @return and @method, generics kept link by link', async () => {
    const registration = createApi().registerMemberTypeProvider(framework);

    try {
      const search = await findMemberSites(settle);

      expect(search.sites.map(lineOf)).toEqual([
        'Invoice::query()->overdue()->first()->settle();',
        'Invoice::factory()->paid()->count(2)->create()->settle();',
        'customer()->invoices()->create([])->settle();',
        'customer()->invoices()->overdue()->first()->settle();',
      ]);
      expect(search.unresolved).toEqual([]);
    } finally {
      registration.dispose();
    }
  });

  test('looks a call forwarded by a relation up on the builder of its model', async () => {
    const registration = createApi().registerMemberTypeProvider(framework);

    try {
      const search = await findMemberSites(overdue);

      expect(search.sites.map(lineOf)).toEqual([
        'Invoice::query()->overdue()->first()->settle();',
        'customer()->invoices()->overdue()->first()->settle();',
        "customer()->invoices()->overdue()->sum('total')->settle();",
      ]);
    } finally {
      registration.dispose();
    }
  });

  test('says nothing without the framework, the generics leading outside the project', async () => {
    const search = await findMemberSites(settle);

    expect(search.sites).toEqual([]);
    expect(search.unresolved).toEqual([]);
  });
});
