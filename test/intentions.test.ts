import { describe, expect, test } from 'bun:test';
import { intentionsAt } from '../src/intentions';
import { applyTextEdits } from '../src/refactor/plan';

function apply(text: string, cursorOn: string, title: string): string {
  const offset = text.indexOf(cursorOn);
  const intention = intentionsAt(text, offset).find((candidate) => candidate.title === title);

  return intention ? applyTextEdits(text, intention.edits) : '';
}

function titles(text: string, cursorOn: string): string[] {
  return intentionsAt(text, text.indexOf(cursorOn)).map((intention) => intention.title);
}

const GUARD = `<?php

declare(strict_types=1);

namespace App;

final class Gate
{
    public function check(bool $isAdmin, bool $isOwner): string
    {
        if ($isAdmin === true) {
            return 'admin';
        } else {
            return 'guest';
        }
    }

    public function nested(bool $isAdmin, bool $isOwner): void
    {
        if ($isAdmin) {
            if ($isOwner) {
                $this->log('both');
            }
        }
    }

    public function greet(string $name): string
    {
        $shout = function (string $value): string {
            return strtoupper($value);
        };

        return 'Hello ' . $name . ', welcome';
    }
}
`;

describe('inverting an if', () => {
  test('swaps the branches and negates the condition', () => {
    const result = apply(GUARD, 'if ($isAdmin === true)', 'Invert if condition');

    expect(result).toContain("if ($isAdmin !== true) {\n            return 'guest';\n        } else {\n            return 'admin';\n        }");
  });

  test('is not offered without an else', () => {
    expect(titles(GUARD, 'if ($isOwner)')).not.toContain('Invert if condition');
  });
});

describe('nesting', () => {
  test('merges a nested if into one condition', () => {
    const result = apply(GUARD, 'if ($isAdmin) {', 'Merge with the nested if');

    expect(result).toContain("if ($isAdmin && $isOwner) {\n            $this->log('both');\n        }");
  });

  test('splits a two-part condition back into two ifs', () => {
    const merged = `<?php

class A
{
    public function run(bool $a, bool $b): void
    {
        if ($a && $b) {
            $this->go();
        }
    }
}
`;
    const result = apply(merged, 'if ($a && $b)', 'Split into two ifs');

    expect(result).toContain('        if ($a) {\n            if ($b) {\n                $this->go();\n            }\n        }');
  });
});

describe('rewriting expressions', () => {
  test('turns a closure that only returns into an arrow function', () => {
    const result = apply(GUARD, 'function (string $value)', 'Convert to arrow function');

    expect(result).toContain('$shout = fn (string $value): string => strtoupper($value);');
  });

  test('turns a concatenation into an interpolated string', () => {
    const result = apply(GUARD, "'Hello '", 'Convert to string interpolation');

    expect(result).toContain('return "Hello {$name}, welcome";');
  });

  test('offers strict_types only where it is missing', () => {
    expect(titles(GUARD, '<?php')).not.toContain('Add declare(strict_types=1)');
    expect(titles('<?php\n\nnamespace App;\n', '<?php')).toContain('Add declare(strict_types=1)');
  });
});
