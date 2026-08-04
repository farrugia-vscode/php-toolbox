import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { parameterHints } = await import('../src/inlayHints');
const { indexedFile } = await import('../src/php/phpIndex');

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

  return parameterHints(file, [file], 0, text.length).map(
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
});
