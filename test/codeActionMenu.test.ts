import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';
import { Position, Range, Uri } from './vscodeStub';

mock.module('vscode', () => vscodeStub);
mock.module('../src/workspaceIndex', () => ({
  getIndex: async () => new Map(),
  onDidChangeFile: () => {},
  warmIndex: () => {},
}));

const { PhpCodeActionProvider } = await import('../src/menu/provider');

const CART = `<?php

namespace App;

final class Cart
{
    public function total(array $lines): float
    {
        $total = 0.0;
        foreach ($lines as $line) {
            $total += $line['price'];
        }

        return round($total, 2);
    }

    public function label(): string
    {
        $name = 'cart';

        return strtoupper($name);
    }
}
`;

/** A document the provider can read, where a position is just an offset. */
function documentOf(text: string) {
  return {
    uri: Uri.file('/p/app/Cart.php'),
    version: 1,
    languageId: 'php',
    getText: () => text,
    offsetAt: (position: Position) => position.character,
    positionAt: (offset: number) => new Position(0, offset),
    lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
  };
}

function titlesAt(text: string, from: number, to = from): string[] {
  const provider = new PhpCodeActionProvider();
  const range = new Range(new Position(0, from), new Position(0, to));

  return provider
    .provideCodeActions(documentOf(text) as never, range as never)
    .map((action) => action.title);
}

describe('what the quick fix menu offers', () => {
  test('offers to extract a method when statements are selected', () => {
    const start = CART.indexOf('$total = 0.0;');
    const end = CART.indexOf('        }\n\n        return') + 9;

    expect(titlesAt(CART, start, end)).toContain('Extract method…');
  });

  test('offers the extractions on an expression, once per identical occurrence', () => {
    const start = CART.indexOf("$line['price']");
    const titles = titlesAt(CART, start, start + "$line['price']".length);

    expect(titles).toContain('Extract variable…');
    expect(titles).toContain('Extract property…');
    expect(titles).not.toContain('Extract constant…');
  });

  test('offers to inline a variable assigned once, on the cursor alone', () => {
    const cursor = CART.indexOf("$name = 'cart';") + 2;

    expect(titlesAt(CART, cursor)).toContain('Inline variable');
  });

  test('offers the method refactorings on a method name', () => {
    const cursor = CART.indexOf('function total(') + 'function '.length + 1;
    const titles = titlesAt(CART, cursor);

    expect(titles).toContain('Inline method');
    expect(titles).toContain('Change signature…');
    expect(titles).toContain('Pull member up…');
  });

  test('keeps the member refactorings out of a method body, where they have no target', () => {
    const titles = titlesAt(CART, CART.indexOf('$total += '));

    expect(titles).not.toContain('Safe delete');
    expect(titles).not.toContain('Pull member up…');
    expect(titles).not.toContain('Push member down…');
  });

  test('offers safe delete on a member name and on the class name', () => {
    const onMethod = CART.indexOf('function total(') + 'function '.length + 1;
    const onClass = CART.indexOf('class Cart') + 'class '.length + 1;

    expect(titlesAt(CART, onMethod)).toContain('Safe delete');
    expect(titlesAt(CART, onClass)).toContain('Safe delete');
  });

  test('offers no refactoring outside the code itself', () => {
    const titles = titlesAt(CART, CART.indexOf('namespace App;') - 1);

    // The file has no strict_types, which is the one thing worth saying up there.
    expect(titles).toEqual(['Add declare(strict_types=1)']);
  });
});

const CHECKOUT = `<?php

namespace App;

interface Payer
{
    public function pay(int $amount): void;
}

final class Checkout implements Payer
{
    public function pay(int $amount): void
    {
        $this->pay($amount);
    }
}
`;

describe('what each place offers', () => {
  test('a class name: the type actions, each exactly once', () => {
    const titles = titlesAt(CHECKOUT, CHECKOUT.indexOf('class Checkout') + 'class '.length + 1);

    expect(titles).toContain('Find usages');
    expect(titles).toContain('Rename…');
    expect(titles).toContain('Move class…');
    expect(titles).toContain('Extract interface…');
    expect(titles).toContain('Generate constructor…');
    expect(titles).toContain('Implement missing methods…');
    expect(titles.filter((title) => title === 'Safe delete')).toHaveLength(1);
    expect(titles.filter((title) => title === 'Rename…')).toHaveLength(1);
  });

  test('an interface name: the narrowed search first, the full one right after', () => {
    const titles = titlesAt(CHECKOUT, CHECKOUT.indexOf('interface Payer') + 'interface '.length + 1);

    expect(titles.slice(0, 2)).toEqual(['Find implementations', 'Find all usages']);
    expect(titles).not.toContain('Extract interface…');
  });

  test('a method name: everything a member allows', () => {
    const titles = titlesAt(CHECKOUT, CHECKOUT.indexOf('function pay(int $amount): void\n    {') + 'function '.length + 1);

    expect(titles).toContain('Find usages');
    expect(titles).toContain('Change signature…');
    expect(titles).toContain('Move method to another class…');
    expect(titles).toContain('Pull member up…');
    expect(titles).toContain('Safe delete');
  });

  test('a call site: what can be done from there, and nothing that needs a declaration', () => {
    const titles = titlesAt(CHECKOUT, CHECKOUT.indexOf('$this->pay(') + '$this->'.length + 1);

    expect(titles).toContain('Find usages');
    expect(titles).toContain('Rename…');
    expect(titles).toContain('Inline method');
    expect(titles).toContain('Change signature…');
    expect(titles).not.toContain('Move method to another class…');
    expect(titles).not.toContain('Pull member up…');
    expect(titles).not.toContain('Safe delete');
  });

  test('a local variable: renamed, never deleted as a member', () => {
    const titles = titlesAt(CART, CART.indexOf("$name = 'cart';") + 2);

    expect(titles.filter((title) => title === 'Rename…')).toHaveLength(1);
    expect(titles).not.toContain('Safe delete');
    expect(titles).not.toContain('Find usages');
  });
});
