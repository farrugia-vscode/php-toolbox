import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Billing/Pricing.php',
    `<?php

namespace App\\Billing;

class Pricing
{
    public function __construct(
        public int $monthlyCents,
        public string $label = 'default',
    ) {
    }

    public static function default(): self
    {
        return new self(monthlyCents: 15000, label: 'MonSiteTaxi');
    }
}
`,
  ],
  [
    'file:///p/app/Billing/CustomPricing.php',
    `<?php

namespace App\\Billing;

final class CustomPricing extends Pricing
{
    public function __construct(int $cents)
    {
        parent::__construct($cents);
    }
}
`,
  ],
  [
    'file:///p/app/Billing/Invoicer.php',
    `<?php

namespace App\\Billing;

final class Invoicer
{
    public function build(Pricing $pricing): int
    {
        $total = $pricing->monthlyCents;
        $pricing->monthlyCents += 100;

        return $total;
    }

    public function make(): Pricing
    {
        return new Pricing(30000, 'Yearly');
    }

    public function subtype(): Pricing
    {
        return new CustomPricing(999);
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

const { parseFile } = await import('../src/php/parser');
const { accessKey, countPropertyAccesses, findMemberSites } = await import('../src/refactor/callSites');

function accessesOf(body: string): Record<string, string> {
  const source = `<?php

final class Order
{
    public function run(): void
    {
${body}
    }
}
`;
  const modes: Record<string, string> = {};

  parseFile(source).accesses.forEach((access) => {
    modes[access.name] = access.access;
  });

  return modes;
}

describe('what a mention does to a property', () => {
  test('a plain assignment writes, and reading elsewhere reads', () => {
    expect(accessesOf('        $this->total = 1;')).toEqual({ total: 'write' });
    expect(accessesOf('        echo $this->total;')).toEqual({ total: 'read' });
  });

  test('adding to a value reads it before storing it', () => {
    expect(accessesOf('        $this->total += 1;')).toEqual({ total: 'readwrite' });
    expect(accessesOf('        $this->total ??= 1;')).toEqual({ total: 'readwrite' });
    expect(accessesOf('        $this->total++;')).toEqual({ total: 'readwrite' });
    expect(accessesOf('        --$this->total;')).toEqual({ total: 'readwrite' });
  });

  test('writing one element keeps the property itself read as well', () => {
    expect(accessesOf("        $this->lines['first'] = 1;")).toEqual({ lines: 'readwrite' });
  });

  test('unset destroys it, an alias can write through it', () => {
    expect(accessesOf('        unset($this->total);')).toEqual({ total: 'write' });
    expect(accessesOf('        $alias = &$this->total;')).toEqual({ total: 'readwrite' });
  });

  test('destructuring writes every target it names', () => {
    expect(accessesOf('        [$this->first, $this->second] = $pair;')).toEqual({
      first: 'write',
      second: 'write',
    });
  });

  test('a foreach writes its targets and reads its source', () => {
    expect(accessesOf('        foreach ($this->lines as $this->current) {}')).toEqual({
      lines: 'read',
      current: 'write',
    });
  });

  test('the receiver of a write is only read', () => {
    expect(accessesOf('        $this->invoice->total = 1;')).toEqual({ invoice: 'read', total: 'write' });
  });
});

describe('a promoted property, which nothing ever assigns', () => {
  test('counts the arguments that build the class as its writes', async () => {
    const { arguments: written } = await findMemberSites({
      kind: 'property',
      name: 'monthlyCents',
      className: 'App\\Billing\\Pricing',
    });

    // `new self(monthlyCents: ...)`, `new Pricing(30000, ...)` and the `parent::__construct($cents)`
    // that `CustomPricing` forwards; `new CustomPricing(999)` fills its own parameter, not this one.
    expect(written.map((site) => site.file.text.slice(site.nameStart, site.nameEnd)).sort()).toEqual([
      '$cents',
      '30000',
      'monthlyCents: 15000',
    ]);
  });

  test('a subclass with a constructor of its own is not read by position', async () => {
    const { arguments: written } = await findMemberSites({
      kind: 'property',
      name: 'label',
      className: 'App\\Billing\\Pricing',
    });

    expect(written.map((site) => site.file.text.slice(site.nameStart, site.nameEnd))).toEqual([
      "label: 'MonSiteTaxi'",
      "'Yearly'",
    ]);
  });
});

describe('counting reads and writes in one pass', () => {
  test('splits both numbers, constructor arguments included', async () => {
    const counts = await countPropertyAccesses([
      { kind: 'property', name: 'monthlyCents', className: 'App\\Billing\\Pricing' },
    ]);

    // Read once on its own, then read and written by `+=`, and written three times at construction.
    expect(counts.get(accessKey({ className: 'App\\Billing\\Pricing', name: 'monthlyCents' }))).toEqual({
      read: 2,
      written: 4,
    });
  });
});
