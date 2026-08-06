import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { parseFile } = await import('../src/php/parser');
const { applyTextEdits, isRefused } = await import('../src/refactor/plan');
const { planSortMembers } = await import('../src/refactor/sortMembers');

function sort(text: string): string {
  const parsed = parseFile(text);
  const plan = planSortMembers(text, parsed, parsed.declarations[0]);

  return isRefused(plan) ? '' : applyTextEdits(text, plan.edits);
}

function refusal(text: string): string {
  const parsed = parseFile(text);
  const plan = planSortMembers(text, parsed, parsed.declarations[0]);

  return isRefused(plan) ? plan.error : '';
}

const SHUFFLED = `<?php

namespace App;

final class Invoicer
{
    private function log(string $line): void
    {
        echo $line;
    }

    public function send(): void
    {
        $this->log('sent');
    }

    private string $reference = '';

    public const STATUS_PAID = 'paid';

    public function __construct(private readonly Mailer $mailer)
    {
    }

    protected static int $count = 0;
}
`;

describe('reordering a class body', () => {
  test('puts the groups in reading order', () => {
    const result = sort(SHUFFLED);
    const positions = [
      result.indexOf('public const STATUS_PAID'),
      result.indexOf('protected static int $count'),
      result.indexOf('private string $reference'),
      result.indexOf('public function __construct'),
      result.indexOf('public function send'),
      result.indexOf('private function log'),
    ];

    expect(positions.every((offset) => offset !== -1)).toBe(true);
    expect([...positions].sort((first, second) => first - second)).toEqual(positions);
  });

  test('leaves what surrounds the body alone', () => {
    const result = sort(SHUFFLED);

    expect(result.startsWith('<?php\n\nnamespace App;\n\nfinal class Invoicer\n{\n')).toBe(true);
    expect(result.trimEnd().endsWith('}\n}')).toBe(true);
  });

  test('does not count a promoted parameter as a property to move', () => {
    expect(sort(SHUFFLED)).toContain('public function __construct(private readonly Mailer $mailer)');
  });

  test('says so when the body is already in order', () => {
    expect(refusal(sort(SHUFFLED))).toContain('already in order');
  });
});

describe('what travels with a member', () => {
  test('keeps the docblock and the attribute written above it', () => {
    const source = `<?php

class Report
{
    public function run(): void
    {
    }

    /**
     * The number of rows the last run wrote.
     */
    #[Deprecated]
    private int $rows = 0;
}
`;
    const result = sort(source);

    expect(result).toContain(`    /**
     * The number of rows the last run wrote.
     */
    #[Deprecated]
    private int $rows = 0;`);
    expect(result.indexOf('private int $rows')).toBeLessThan(result.indexOf('public function run'));
  });
});

describe('what reordering would break', () => {
  test('refuses a body with a trait import between two members', () => {
    const source = `<?php

class Report
{
    public function run(): void
    {
    }

    use Loggable;

    private int $rows = 0;
}
`;

    expect(refusal(source)).toContain('code written between its members');
  });

  test('refuses a class with a single member, which has no order to fix', () => {
    expect(refusal(`<?php\n\nclass A\n{\n    public function run(): void\n    {\n    }\n}\n`)).toContain(
      'nothing to reorder',
    );
  });
});
