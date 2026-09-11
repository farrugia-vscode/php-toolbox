import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Payment/Reader.php',
    `<?php

namespace App\\Payment;

final class Reader
{
    public const CURRENCY = 'EUR';

    private const RETRIES = 3;

    public function execute(string $id): string
    {
        return $this->describe($id);
    }

    private function describe(string $id): string
    {
        return $id . self::CURRENCY . self::RETRIES;
    }
}
`,
  ],
  [
    'file:///p/app/Payment/Caller.php',
    `<?php

namespace App\\Payment;

final class Caller
{
    public function run(Reader $reader): void
    {
        $reader->execute('a');
        $reader->execute('b');

        echo Reader::CURRENCY;
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

const { accessKey, countMemberUsages } = await import('../src/refactor/callSites');

const CLASS_NAME = 'App\\Payment\\Reader';

async function countsFor() {
  return countMemberUsages([
    { kind: 'method', name: 'execute', className: CLASS_NAME },
    { kind: 'method', name: 'describe', className: CLASS_NAME },
    { kind: 'constant', name: 'CURRENCY', className: CLASS_NAME },
    { kind: 'constant', name: 'RETRIES', className: CLASS_NAME },
  ]);
}

const countOf = (counts: Map<string, { read: number; written: number }>, name: string) =>
  counts.get(accessKey({ className: CLASS_NAME, name }));

describe('counting method calls and constant usages', () => {
  test('counts the calls of a public method', async () => {
    expect(countOf(await countsFor(), 'execute')).toEqual({ read: 2, written: 0 });
  });

  test('counts the calls of a private method too', async () => {
    expect(countOf(await countsFor(), 'describe')).toEqual({ read: 1, written: 0 });
  });

  test('counts a constant used from inside and outside the class', async () => {
    expect(countOf(await countsFor(), 'CURRENCY')).toEqual({ read: 2, written: 0 });
  });

  test('counts a private constant', async () => {
    expect(countOf(await countsFor(), 'RETRIES')).toEqual({ read: 1, written: 0 });
  });

  // Declared last on purpose: it leaves an extra file behind.
  test('keeps the counts until something is parsed again', async () => {
    const before = countOf(await countsFor(), 'execute');

    files.set(
      'file:///p/app/Payment/Extra.php',
      `<?php

namespace App\\Payment;

final class Extra
{
    public function run(Reader $reader): void
    {
        $reader->execute('c');
    }
}
`,
    );

    expect(countOf(await countsFor(), 'execute')).toEqual(before!);
  });
});
