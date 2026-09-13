import { describe, expect, test } from 'bun:test';
import { tokenizePhpLine } from '../src/phpTokens';

const kinds = (line: string) => tokenizePhpLine(line).map((token) => `${token.kind}:${token.text}`);

describe('colouring a line of PHP', () => {
  test('tells strings, variables, calls, classes and keywords apart', () => {
    expect(kinds("$claims = JWT::decode((string) $query['token'], new Key(config('services.internal.token'), 'HS256'));")).toEqual([
      'variable:$claims', 'plain: = ', 'class:JWT', 'plain:::', 'function:decode', 'plain:((', 'keyword:string', 'plain:) ',
      'variable:$query', 'plain:[', "string:'token'", 'plain:], ', 'keyword:new', 'plain: ', 'class:Key', 'plain:(',
      'function:config', 'plain:(', "string:'services.internal.token'", 'plain:), ', "string:'HS256'", 'plain:));',
    ]);
  });

  test('reads a property after an arrow as a variable, a constant by its case, a namespace as a class', () => {
    expect(kinds('$user->name ?? PHP_EOL . \\App\\Models\\User::class')).toEqual([
      'variable:$user', 'plain:->', 'variable:name', 'plain: ?? ', 'constant:PHP_EOL', 'plain: . ', 'class:\\App\\Models\\User', 'plain:::', 'keyword:class',
    ]);
  });

  test('keeps a comment and an unterminated string whole', () => {
    expect(kinds("__('errors.404 // not a comment")).toEqual(['function:__', 'plain:(', "string:'errors.404 // not a comment"]);
    expect(kinds('return 42; // the answer')).toEqual(['keyword:return', 'plain: ', 'number:42', 'plain:; ', 'comment:// the answer']);
  });

  test('gives the whole label back, piece by piece', () => {
    const line = "public function ship(Order $order): ?Invoice { return $this->invoices->first(fn (Invoice $invoice) => $invoice->isPaid()); }";

    expect(tokenizePhpLine(line).map((token) => token.text).join('')).toBe(line);
  });
});
