import { describe, expect, test } from 'bun:test';
import { classNamesOf, isSelfType, splitChain } from '../src/php/receiverType';

describe('splitting a receiver expression', () => {
  test('reads a chain down to its root', () => {
    expect(splitChain("DB::connection('tenant')->table('users')->where('email', 'a@b.c')")).toEqual({
      root: 'DB',
      links: [
        { name: 'connection', isCall: true },
        { name: 'table', isCall: true },
        { name: 'where', isCall: true },
      ],
    });
  });

  test('ignores the arrows written inside arguments', () => {
    expect(splitChain('$repository->of($user->team()->id)')).toEqual({
      root: '$repository',
      links: [{ name: 'of', isCall: true }],
    });
  });

  test('ignores the arrows written inside strings', () => {
    expect(splitChain("$logger->with('a->b::c')")).toEqual({
      root: '$logger',
      links: [{ name: 'with', isCall: true }],
    });
  });

  test('tells a property apart from a call', () => {
    expect(splitChain('$this->provisioner')).toEqual({
      root: '$this',
      links: [{ name: 'provisioner', isCall: false }],
    });
  });

  test('gives up on a member named at runtime', () => {
    expect(splitChain('$order->$field')).toEqual({ root: '$order->$field', links: [] });
  });

  test('reads a nullsafe step like any other', () => {
    expect(splitChain('$order?->customer()')).toEqual({
      root: '$order',
      links: [{ name: 'customer', isCall: true }],
    });
  });
});

describe('reading a declared type', () => {
  test('keeps the classes and drops what names none', () => {
    expect(classNamesOf('?Customer')).toEqual(['Customer']);
    expect(classNamesOf('Customer|null')).toEqual(['Customer']);
    expect(classNamesOf('array')).toEqual([]);
    expect(classNamesOf('static')).toEqual([]);
  });

  test('spots a fluent return, alone or in a union', () => {
    expect(isSelfType('static')).toBe(true);
    expect(isSelfType('$this|null')).toBe(true);
    expect(isSelfType('Builder')).toBe(false);
  });
});
