import { describe, expect, test } from 'bun:test';
import { findDeclaredType } from '../src/php/declaredType';

/** Reads the type declared by the member the marker `|` sits on. */
function declared(source: string): string | null {
  const offset = source.indexOf('|');
  const text = source.replace('|', '');
  const found = findDeclaredType(text, offset);

  return found ? `${found.name}@${text.slice(found.offset, found.offset + found.name.length)}` : null;
}

describe('findDeclaredType', () => {
  test('reads the return type of a method', () => {
    expect(declared('public function |customer(): BelongsTo\n{')).toBe('BelongsTo@BelongsTo');
  });

  test('points at the type itself, so it can be resolved where it is written', () => {
    const text = 'public function customer(): BelongsTo\n{';
    const found = findDeclaredType(text, text.indexOf('customer'));

    expect(found?.offset).toBe(text.indexOf('BelongsTo'));
  });

  test('unwraps a nullable or a union with null', () => {
    expect(declared('public function |customer(): ?BelongsTo\n{')).toBe('BelongsTo@BelongsTo');
    expect(declared('public function |customer(): null|BelongsTo\n{')).toBe('BelongsTo@BelongsTo');
  });

  test('sees past the parameter list, defaults included', () => {
    expect(declared("public function |query(string $name = '():'): Builder\n{")).toBe('Builder@Builder');
  });

  test('falls back to the docblock when there is no native return type', () => {
    const source = '/**\n * @return BelongsTo\n */\npublic function |customer()\n{';

    expect(declared(source)).toBe('BelongsTo@BelongsTo');
  });

  test('reads the type of a property', () => {
    expect(declared('private readonly ?Customer |$customer;')).toBe('Customer@Customer');
  });

  test('reads a type declared by annotation only', () => {
    expect(declared(' * @property-read Customer |$customer')).toBe('Customer@Customer');
    expect(declared(' * @method static Builder |query()')).toBe('Builder@Builder');
  });

  test('ignores types that name no class', () => {
    expect(declared('public function |total(): int\n{')).toBeNull();
    expect(declared('private |$customer;')).toBeNull();
  });

  test('marks a fluent return, which names the declaring class rather than another one', () => {
    const source = '/**\n * @return $this\n */\npublic function |where($column)\n{';

    expect(findDeclaredType(source.replace('|', ''), source.indexOf('|'))).toMatchObject({
      name: '$this',
      isSelfType: true,
    });

    expect(declared('public function |fresh(): static\n{')).toBe('static@static');
    expect(declared('public function |copy(): self\n{')).toBe('self@self');
  });
});
