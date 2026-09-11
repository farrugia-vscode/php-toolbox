import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';
import { Position, Range, Uri } from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Events/OrderPlaced.php',
    `<?php

namespace App\\Events;

final class OrderPlaced
{
}
`,
  ],
  [
    'file:///p/app/Checkout.php',
    `<?php

namespace App;

use App\\Events\\OrderPlaced;

final class Checkout
{
    public function __construct(private OrderPlaced $placed)
    {
    }

    public function run(): void
    {
        event(new OrderPlaced());
        OrderPlaced::dispatch();
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

const { createApi } = await import('../src/api');
const { categoryOrder, findUsages, referenceCategories } = await import('../src/usages');

const token = { isCancellationRequested: false } as never;
const declaring = Uri.parse('file:///p/app/Events/OrderPlaced.php') as never;

describe('the usages of a type', () => {
  test('are read from the code, grouped by what it does with the type', async () => {
    const usages = await findUsages('OrderPlaced', declaring, token);

    expect(usages.map((usage) => `${usage.category}: ${usage.code}`)).toEqual([
      'Instantiated: event(new OrderPlaced());',
      'Injected or type hinted: public function __construct(private OrderPlaced $placed)',
      'Static access: OrderPlaced::dispatch();',
    ]);
    expect(usages.every((usage) => referenceCategories().includes(usage.category))).toBe(true);
  });

  test('take what another extension knows, under a heading of its own, listed last', async () => {
    const registration = createApi().registerUsageProvider({
      category: 'Listened by',
      find: async (symbol) =>
        symbol.fqn === 'App\\Events\\OrderPlaced'
          ? [{ uri: Uri.parse('file:///p/app/Listeners/SendReceipt.php') as never, range: new Range(new Position(6, 12), new Position(6, 23)) as never, label: 'SendReceipt' }]
          : [],
    });

    try {
      const usages = await findUsages('OrderPlaced', declaring, token);

      expect(usages.filter((usage) => usage.category === 'Listened by').map((usage) => usage.code)).toEqual(['SendReceipt']);
      expect(categoryOrder().at(-1)).toBe('Listened by');
      expect(referenceCategories()).toContain('Listened by');
    } finally {
      registration.dispose();
    }
  });

  test('survive a provider that fails, keeping what the code shows', async () => {
    const registration = createApi().registerUsageProvider({
      category: 'Broken',
      find: async () => {
        throw new Error('no server');
      },
    });
    const errors = console.error;
    console.error = () => {};

    try {
      expect((await findUsages('OrderPlaced', declaring, token)).length).toBe(3);
    } finally {
      console.error = errors;
      registration.dispose();
    }
  });
});
