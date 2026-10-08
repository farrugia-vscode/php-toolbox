import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { classNameOf, readHoverType } = await import('../src/mixinResolution');

describe('classNameOf', () => {
  test('reads the class out of an annotated type', () => {
    expect(classNameOf('\\App\\Models\\Customer|null')).toBe('App\\Models\\Customer');
    expect(classNameOf('Customer')).toBe('Customer');
  });

  test('keeps the class of a generic type, whose arguments say nothing about members', () => {
    expect(classNameOf('\\Illuminate\\Database\\Eloquent\\Builder<static>')).toBe(
      'Illuminate\\Database\\Eloquent\\Builder',
    );
  });

  test('reads the element type of a collection written as an array', () => {
    expect(classNameOf('Invoice[]')).toBe('Invoice');
  });

  test('has nothing to offer for a scalar or an empty type', () => {
    expect(classNameOf('int')).toBe('int');
    expect(classNameOf('')).toBeNull();
    expect(classNameOf('null')).toBeNull();
    expect(classNameOf('array<array-key, mixed>')).toBe('array');
  });
});

describe('readHoverType', () => {
  test('does not read the language of a code fence as a type', () => {
    expect(readHoverType('```php\n$this\n```\n', 'this')).toBeNull();
    expect(readHoverType('```php\n<?php\n$page\n```', 'page')).toBeNull();
  });

  test('reads the type Intelephense writes after @var', () => {
    expect(readHoverType('_@var_ `\\App\\Models\\Notification $this`', 'this')).toBe('\\App\\Models\\Notification');
  });

  test('has nothing to offer for mixed', () => {
    expect(readHoverType('@var mixed $row', 'row')).toBeNull();
  });
});
