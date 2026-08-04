import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { classNameOf } = await import('../src/mixinResolution');

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
