import { describe, expect, test } from 'bun:test';
import { intentionsAt } from '../src/intentions';
import { applyTextEdits } from '../src/refactor/plan';

function documented(text: string, cursorOn: string): string {
  const offset = text.indexOf(cursorOn);
  const intention = intentionsAt(text, offset).find((candidate) => candidate.title === 'Add PHPDoc');

  return intention ? applyTextEdits(text, intention.edits) : '';
}

describe('writing the docblock a method is missing', () => {
  test('annotates what the signature cannot say: element types and thrown exceptions', () => {
    const source = [
      '<?php',
      'class Basket',
      '{',
      '    public function total(array $lines, int $vatRate): array',
      '    {',
      '        throw new EmptyBasketException();',
      '    }',
      '}',
    ].join('\n');

    const result = documented(source, 'public function total');

    expect(result).toContain('     * @param array<mixed> $lines');
    expect(result).toContain('     * @return array<mixed>');
    expect(result).toContain('     * @throws EmptyBasketException');
    expect(result).not.toContain('@param int $vatRate');
  });

  test('writes a single tag on one line', () => {
    const source = `<?php\nclass A\n{\n    public function all(): array\n    {\n        return [];\n    }\n}`;

    expect(documented(source, 'public function all')).toContain('/** @return array<mixed> */');
  });

  test('says nothing when the signature already carries everything', () => {
    const source = `<?php\nclass A\n{\n    public function name(int $id): string\n    {\n        return '';\n    }\n}`;

    expect(documented(source, 'public function name')).toBe('');
  });

  test('leaves a method that already has a docblock alone', () => {
    const source = [
      '<?php',
      'class A',
      '{',
      '    /** @return array<string> */',
      '    public function all(): array',
      '    {',
      '        return [];',
      '    }',
      '}',
    ].join('\n');

    expect(documented(source, 'public function all')).toBe('');
  });

  test('is offered from the signature, not from inside the body', () => {
    const source = `<?php\nclass A\n{\n    public function all(): array\n    {\n        $rows = [];\n        return $rows;\n    }\n}`;

    expect(documented(source, '$rows = []')).toBe('');
  });
});
