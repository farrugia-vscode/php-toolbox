import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { parameterHints } = await import('../src/inlayHints');
const { indexedFile } = await import('../src/php/phpIndex');
const { projectFrom } = await import('../src/refactor/callSites');

const SOURCE = `<?php

class Money
{
    public function __construct(int $amount, string $currency) {}
}

class Basket
{
    public function log(string $message, bool $isUrgent): void {}

    public function checkout(string $message): void
    {
        $price = new Money(1000, 'EUR');
        $this->log('done', true);
        $this->log($message, false);
    }
}
`;

/** The hints drawn for the whole file, as `label@text`. */
function hints(text: string): string[] {
  const file = indexedFile(vscodeStub.Uri.file('/app/Basket.php') as never, text);

  return parameterHints(file, projectFrom([file]), 0, text.length).map(
    (hint) => `${hint.label}${text.slice(hint.offset, hint.offset + 8).split(/[,)]/)[0]}`,
  );
}

describe('naming the arguments of a call', () => {
  test('names the arguments of a constructor', () => {
    expect(hints(SOURCE)).toContain("amount:1000");
    expect(hints(SOURCE)).toContain("currency:'EUR'");
  });

  test('names the arguments of a call on $this', () => {
    expect(hints(SOURCE)).toContain("message:'done'");
    expect(hints(SOURCE)).toContain('isUrgent:true');
  });

  test('stays quiet when the variable already carries the parameter name', () => {
    expect(hints(SOURCE)).not.toContain('message:$message');
  });

  test('says nothing about a call whose target needs a type to be known', () => {
    const source = `<?php\nclass A { function f($service) { $service->send('x', 1); } }`;

    expect(hints(source)).toEqual([]);
  });

  test('names a call on a variable once its type is declared', () => {
    const source = `${SOURCE}
final class Checkout
{
    public function run(Basket $basket): void
    {
        $basket->log('paid', true);
    }
}
`;

    expect(hints(source)).toContain("message:'paid'");
    expect(hints(source)).toContain('isUrgent:true');
  });

  test('stays quiet when the argument is a call that already says the name', () => {
    const source = `${SOURCE}
final class Clock
{
    public function tick(Basket $basket): void
    {
        $basket->log(message(), true);
    }
}

function message(): string
{
    return 'x';
}
`;

    expect(hints(source)).not.toContain('message:message()');
  });

  test('keeps the hints of a call the viewport cuts in half', () => {
    const file = indexedFile(vscodeStub.Uri.file('/app/Basket.php') as never, SOURCE);
    const call = SOURCE.indexOf("$this->log('done'");

    // A range ending inside the call: what VS Code asks for when it is scrolled to its top.
    const cut = parameterHints(file, projectFrom([file]), 0, call + 12);

    expect(cut.map((hint) => hint.label)).toContain('message:');
  });
});
