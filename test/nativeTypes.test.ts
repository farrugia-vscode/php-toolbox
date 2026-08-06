import { describe, expect, test } from 'bun:test';
import { intentionsAt } from '../src/intentions';
import { applyTextEdits } from '../src/refactor/plan';

const TITLE = 'Move PHPDoc types into the signature';

function move(text: string, cursorOn: string): string {
  const offset = text.indexOf(cursorOn);
  const intention = intentionsAt(text, offset).find((candidate) => candidate.title === TITLE);

  return intention ? applyTextEdits(text, intention.edits) : '';
}

function isOffered(text: string, cursorOn: string): boolean {
  return intentionsAt(text, text.indexOf(cursorOn)).some((candidate) => candidate.title === TITLE);
}

describe('types the signature can carry', () => {
  test('writes them into the signature and drops the docblock they emptied', () => {
    const source = `<?php

class Invoicer
{
    /**
     * @param int $count
     * @param string|null $label
     * @return bool
     */
    public function send($count, $label)
    {
        return true;
    }
}
`;
    const result = move(source, 'public function send');

    expect(result).toContain('public function send(int $count, string|null $label): bool');
    expect(result).not.toContain('@param');
    expect(result).not.toContain('/**');
  });

  test('keeps the docblock when something else is written in it', () => {
    const source = `<?php

class Invoicer
{
    /**
     * Sends the invoice to the customer.
     *
     * @param int $count
     * @throws SendFailed
     */
    public function send($count): void
    {
    }
}
`;
    const result = move(source, 'public function send');

    expect(result).toContain('public function send(int $count): void');
    expect(result).toContain('Sends the invoice to the customer.');
    expect(result).toContain('@throws SendFailed');
    expect(result).not.toContain('@param');
  });

  test('reads a nullable written the short way', () => {
    const source = `<?php

class Invoicer
{
    /** @param ?Customer $customer */
    public function send($customer): void
    {
    }
}
`;

    expect(move(source, 'public function send')).toContain('public function send(?Customer $customer): void');
  });
});

describe('types only an analyser understands', () => {
  test('leaves a generic array where it is', () => {
    const source = `<?php

class Invoicer
{
    /**
     * @param array<int, string> $rows
     * @param int $count
     */
    public function send($rows, $count): void
    {
    }
}
`;
    const result = move(source, 'public function send');

    expect(result).toContain('public function send($rows, int $count): void');
    expect(result).toContain('@param array<int, string> $rows');
  });

  test('leaves class-string alone, which is not a class name', () => {
    const source = `<?php

class Invoicer
{
    /** @param class-string $handler */
    public function send($handler): void
    {
    }
}
`;

    expect(isOffered(source, 'public function send')).toBe(false);
  });

  test('leaves an array shape alone', () => {
    const source = `<?php

class Invoicer
{
    /** @return array{total: int} */
    public function totals()
    {
    }
}
`;

    expect(isOffered(source, 'public function totals')).toBe(false);
  });
});

describe('what is already enforced', () => {
  test('drops a line the signature already says, without touching the signature', () => {
    const source = `<?php

class Invoicer
{
    /**
     * @param int $count
     * @param string $label
     */
    public function send(int $count, $label): void
    {
    }
}
`;
    const result = move(source, 'public function send');

    expect(result).toContain('public function send(int $count, string $label): void');
    expect(result).not.toContain('@param');
  });

  test('keeps a docblock that only repeats the signature, having nothing to move', () => {
    const source = `<?php

class Invoicer
{
    /** @param int $count */
    public function send(int $count): void
    {
    }
}
`;

    expect(isOffered(source, 'public function send')).toBe(false);
  });

  test('is not offered from inside the body', () => {
    const source = `<?php

class Invoicer
{
    /** @param int $count */
    public function send($count): void
    {
        $this->log($count);
    }
}
`;

    expect(isOffered(source, '$this->log')).toBe(false);
  });
});
