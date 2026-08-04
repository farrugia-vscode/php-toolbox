import { describe, expect, test } from 'bun:test';
import { findMemberAccess, findReceiverMember, findReceiverVariable } from '../src/php/receiverChain';

/** Resolves the receiver for a cursor written as `|` in the source. */
function receiver(source: string): string | null {
  const offset = source.indexOf('|');
  const found = findReceiverMember(source.replace('|', ''), offset);

  return found ? `${found.name}@${found.offset}` : null;
}

function variable(source: string): string | null {
  const offset = source.indexOf('|');
  const found = findReceiverVariable(source.replace('|', ''), offset);

  return found ? `${found.name}@${found.offset}` : null;
}

function member(source: string): string | null {
  const offset = source.indexOf('|');
  const found = findMemberAccess(source.replace('|', ''), offset);

  return found ? `${found.name}@${found.start}-${found.end}` : null;
}

describe('findReceiverMember', () => {
  test('reads the method call the chain comes from', () => {
    expect(receiver('$invoice->customer()->exis|')).toBe('customer@10');
  });

  test('works before anything is typed', () => {
    expect(receiver('$invoice->customer()->|')).toBe('customer@10');
  });

  test('reads a property access', () => {
    expect(receiver('$invoice->customer->exis|')).toBe('customer@10');
  });

  test('skips over call arguments, parentheses and strings included', () => {
    expect(receiver("$user->orders()->where('total', ')')->firs|")).toBe('where@17');
  });

  test('follows a static call', () => {
    expect(receiver('Invoice::query()->exis|')).toBe('query@9');
  });

  test('crosses the line breaks of a wrapped chain', () => {
    expect(receiver('$user->orders()\n    ->exis|')).toBe('orders@7');
  });

  test('accepts the nullsafe operator', () => {
    expect(receiver('$invoice->customer()?->exis|')).toBe('customer@10');
  });

  test('refuses a variable receiver, whose type comes from an assignment', () => {
    expect(receiver('$invoice->exis|')).toBeNull();
    expect(receiver('$this->exis|')).toBeNull();
  });

  test('refuses anything that is not a member access', () => {
    expect(receiver('$invoice = 1;|')).toBeNull();
    expect(receiver('Invoice::quer|')).toBeNull();
  });
});

describe('findReceiverVariable', () => {
  test('reads the variable a member access hangs off, pointing at the dollar', () => {
    expect(variable('$site->stat|')).toBe('site@0');
    expect(variable('$site->|')).toBe('site@0');
    expect(variable('$site?->stat|')).toBe('site@0');
  });

  test('refuses a call receiver, which findReceiverMember handles', () => {
    expect(variable('$site->customer()->stat|')).toBeNull();
    expect(variable('Site::query()->stat|')).toBeNull();
  });
});

describe('findMemberAccess', () => {
  test('reads the member the cursor sits on', () => {
    expect(member('$site->cust|omer;')).toBe('customer@7-15');
    expect(member('$site->|customer;')).toBe('customer@7-15');
  });

  test('ignores a name that is not read off an arrow', () => {
    expect(member('$cust|omer;')).toBeNull();
    expect(member('Site::quer|y();')).toBeNull();
  });
});
