import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { findWordPosition, parseDocblockMembers } = await import('../src/typeReferences');

function makeDocument(lines: string[]) {
  return { lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] }) } as never;
}

describe('findWordPosition', () => {
  test('skips a namespace segment with the same name as the class', () => {
    const document = makeDocument([
      'use App\\Exceptions\\Page\\LegalPageNotDuplicableException;',
      'use App\\Models\\Page;',
    ]);

    expect(findWordPosition(document, 'Page', 0, 1)).toEqual(new vscodeStub.Position(1, 15));
  });
});

describe('parseDocblockMembers', () => {
  test('reads a property type that holds a space', () => {
    const document = makeDocument([
      '/**',
      ' * @property array<array-key, mixed>|null $photo_paths',
      ' */',
      'final class IdeHelperVehicle {}',
    ]);
    const classSymbol = { selectionRange: { start: { line: 3 } } } as never;

    expect(parseDocblockMembers(document, classSymbol)[0]).toMatchObject({
      name: '$photo_paths',
      detail: 'array<array-key, mixed>|null',
    });
  });
});
