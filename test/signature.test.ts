import { describe, expect, test } from 'bun:test';
import { parseFile } from '../src/php/parser';
import { applyTextEdits } from '../src/refactor/plan';
import { callEdit, declarationEdit, describeParams, parseParams, splitTopLevel } from '../src/refactor/signature';

const MAILER = `<?php

namespace App;

final class Mailer
{
    public function send(string $to, string $subject, int $retries = 3): void
    {
    }

    public function run(): void
    {
        $this->send('a@b.c', 'Hi');
    }
}
`;

const method = parseFile(MAILER).methods.find((candidate) => candidate.name === 'send')!;

describe('changing a signature', () => {
  test('describes the current parameters with the slot each one holds', () => {
    expect(describeParams(method)).toBe('#1 string $to, #2 string $subject, #3 int $retries = 3');
  });

  test('splits on commas the arguments themselves do not own', () => {
    expect(splitTopLevel("['a', 'b'], foo(1, 2), 3")).toEqual(["['a', 'b']", 'foo(1, 2)', '3']);
  });

  test('carries the arguments over when parameters are reordered', () => {
    const specs = parseParams('#2 string $subject, #1 string $to, #3 int $retries = 3');

    if ('error' in specs) {
      throw new Error(specs.error);
    }

    const call = parseFile(MAILER).calls.find((candidate) => candidate.name === 'send')!;
    const edits = [declarationEdit(method, specs), callEdit(MAILER, call, method, specs)] as never;

    expect(applyTextEdits(MAILER, edits)).toContain("$this->send('Hi', 'a@b.c');");
    expect(applyTextEdits(MAILER, edits)).toContain(
      'public function send(string $subject, string $to, int $retries = 3): void',
    );
  });

  test('passes the given value for a parameter that did not exist', () => {
    const specs = parseParams('#1 string $to, #2 string $subject, #3 int $retries = 3, string $locale');

    if ('error' in specs) {
      throw new Error(specs.error);
    }

    specs[3].argumentText = "'fr'";

    const call = parseFile(MAILER).calls.find((candidate) => candidate.name === 'send')!;
    const edit = callEdit(MAILER, call, method, specs);

    expect(applyTextEdits(MAILER, [edit] as never)).toContain("$this->send('a@b.c', 'Hi', 3, 'fr');");
  });

  test('rejects a parameter that is not written as PHP would', () => {
    expect(parseParams('string locale')).toEqual({ error: 'string locale is not a valid parameter.' });
  });
});
