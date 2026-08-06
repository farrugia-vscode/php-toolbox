import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { parseFile } = await import('../src/php/parser');
const { unusedPrivateMembers } = await import('../src/unusedMembers');

function unused(text: string): string[] {
  return unusedPrivateMembers(text, parseFile(text)).map((member) => member.name);
}

describe('private members nothing reaches', () => {
  test('reports the method, the property and the constant left over', () => {
    const source = `<?php

namespace App;

final class Invoicer
{
    private const RATE = 0.2;

    private int $attempts = 0;

    public function send(): void
    {
        $this->log('sent');
    }

    private function log(string $line): void
    {
        echo $line;
    }

    private function unusedHelper(): void
    {
    }
}
`;

    expect(unused(source)).toEqual(['unusedHelper', 'attempts', 'RATE']);
  });

  test('says nothing about what the file uses', () => {
    const source = `<?php

class Invoicer
{
    private const RATE = 0.2;

    private int $attempts = 0;

    public function send(): float
    {
        $this->attempts++;

        return self::RATE;
    }
}
`;

    expect(unused(source)).toEqual([]);
  });

  test('leaves public and protected members alone, which another file may reach', () => {
    const source = `<?php

class Invoicer
{
    protected int $attempts = 0;

    public function send(): void
    {
    }

    protected function log(): void
    {
    }
}
`;

    expect(unused(source)).toEqual([]);
  });
});

describe('what could be reached without a call to read', () => {
  test('says nothing when the name is written as a string', () => {
    const source = `<?php

class Invoicer
{
    public function send(): void
    {
        array_map([$this, 'log'], ['sent']);
    }

    private function log(string $line): void
    {
        echo $line;
    }
}
`;

    expect(unused(source)).toEqual([]);
  });

  test('gives up on a file that builds a member name at runtime', () => {
    const source = `<?php

class Invoicer
{
    private int $attempts = 0;

    public function send(string $member): void
    {
        $this->$member();
    }

    private function log(): void
    {
    }
}
`;

    expect(unused(source)).toEqual([]);
  });

  test('leaves a member carrying an attribute alone', () => {
    const source = `<?php

class InvoicerTest
{
    #[Test]
    private function it_sends(): void
    {
    }
}
`;

    expect(unused(source)).toEqual([]);
  });

  test('leaves the magic methods alone, which PHP calls itself', () => {
    const source = `<?php

class Invoicer
{
    private function __construct()
    {
    }

    private function __clone(): void
    {
    }
}
`;

    expect(unused(source)).toEqual([]);
  });
});

describe('promoted constructor properties', () => {
  test('reports one the class never reads', () => {
    const source = `<?php

class Invoicer
{
    public function __construct(private readonly Mailer $mailer, private int $retries)
    {
    }

    public function send(): void
    {
        $this->mailer->send();
    }
}
`;

    expect(unused(source)).toEqual(['retries']);
  });
});
