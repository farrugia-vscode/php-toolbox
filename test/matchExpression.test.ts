import { describe, expect, test } from 'bun:test';
import { intentionsAt } from '../src/intentions';
import { applyTextEdits } from '../src/refactor/plan';

function convert(text: string, cursorOn: string): string {
  const offset = text.indexOf(cursorOn);
  const intention = intentionsAt(text, offset).find((candidate) => candidate.title === 'Convert to match');

  return intention ? applyTextEdits(text, intention.edits) : '';
}

function isOffered(text: string, cursorOn: string): boolean {
  return intentionsAt(text, text.indexOf(cursorOn)).some((candidate) => candidate.title === 'Convert to match');
}

function wrap(body: string): string {
  return `<?php

class Labels
{
    public function run(string $status, int $level): string
    {
${body}
    }
}
`;
}

describe('an if chain returning a value', () => {
  const chain = wrap(`        if ($status === 'draft') {
            return 'Brouillon';
        } elseif ($status === 'paid' || $status === 'done') {
            return 'Payé';
        } else {
            return 'Inconnu';
        }`);

  test('reads the subject every branch compares', () => {
    expect(convert(chain, "if ($status === 'draft')")).toContain(`        return match ($status) {
            'draft' => 'Brouillon',
            'paid', 'done' => 'Payé',
            default => 'Inconnu',
        };`);
  });

  test('is offered on the condition, not inside a branch', () => {
    expect(isOffered(chain, "return 'Brouillon'")).toBe(false);
  });

  test('is offered from the first if only, so the whole chain is converted', () => {
    expect(isOffered(chain, "$status === 'paid'")).toBe(false);
  });
});

describe('an if chain assigning a value', () => {
  test('assigns the match to the same variable', () => {
    const chain = wrap(`        if ($level > 10) {
            $label = 'high';
        } else {
            $label = 'low';
        }

        return $label;`);

    expect(convert(chain, 'if ($level > 10)')).toContain(`        $label = match (true) {
            $level > 10 => 'high',
            default => 'low',
        };`);
  });

  test('refuses branches that assign different variables', () => {
    const chain = wrap(`        if ($level > 10) {
            $label = 'high';
        } else {
            $other = 'low';
        }

        return $label;`);

    expect(isOffered(chain, 'if ($level > 10)')).toBe(false);
  });

  test('refuses a compound assignment, which reads the variable it writes', () => {
    const chain = wrap(`        if ($level > 10) {
            $label .= 'high';
        } else {
            $label .= 'low';
        }

        return $label;`);

    expect(isOffered(chain, 'if ($level > 10)')).toBe(false);
  });
});

describe('what a match cannot say', () => {
  test('refuses a chain without an else, which would throw instead of doing nothing', () => {
    const chain = wrap(`        if ($status === 'draft') {
            return 'Brouillon';
        }

        return 'Inconnu';`);

    expect(isOffered(chain, "if ($status === 'draft')")).toBe(false);
  });

  test('refuses a branch doing more than producing the value', () => {
    const chain = wrap(`        if ($status === 'draft') {
            $this->log('draft');

            return 'Brouillon';
        } else {
            return 'Inconnu';
        }`);

    expect(isOffered(chain, "if ($status === 'draft')")).toBe(false);
  });

  test('refuses branches that mix a return with an assignment', () => {
    const chain = wrap(`        if ($status === 'draft') {
            return 'Brouillon';
        } else {
            $label = 'Inconnu';
        }

        return $label;`);

    expect(isOffered(chain, "if ($status === 'draft')")).toBe(false);
  });
});

describe('a switch', () => {
  test('folds the cases that fall through into one arm', () => {
    const switched = wrap(`        switch ($level) {
            case 1:
            case 2:
                $points = 10;
                break;
            case 3:
                $points = 20;
                break;
            default:
                $points = 0;
        }

        return (string) $points;`);

    expect(convert(switched, 'switch ($level)')).toContain(`        $points = match ($level) {
            1, 2 => 10,
            3 => 20,
            default => 0,
        };`);
  });

  test('converts cases that return', () => {
    const switched = wrap(`        switch ($status) {
            case 'draft':
                return 'Brouillon';
            default:
                return 'Inconnu';
        }`);

    expect(convert(switched, 'switch ($status)')).toContain(`        return match ($status) {
            'draft' => 'Brouillon',
            default => 'Inconnu',
        };`);
  });

  test('refuses a switch with no default', () => {
    const switched = wrap(`        switch ($status) {
            case 'draft':
                return 'Brouillon';
            case 'paid':
                return 'Payé';
        }

        return 'Inconnu';`);

    expect(isOffered(switched, 'switch ($status)')).toBe(false);
  });

  test('refuses a case that falls out of the switch without a body', () => {
    const switched = wrap(`        switch ($status) {
            default:
                return 'Inconnu';
            case 'draft':
        }

        return 'x';`);

    expect(isOffered(switched, 'switch ($status)')).toBe(false);
  });
});
