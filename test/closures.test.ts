import { describe, expect, test } from 'bun:test';
import { intentionsAt } from '../src/intentions';
import { applyTextEdits } from '../src/refactor/plan';

function apply(text: string, cursorOn: string, title: string): string {
  const offset = text.indexOf(cursorOn);
  const intention = intentionsAt(text, offset).find((candidate) => candidate.title.startsWith(title));

  return intention ? applyTextEdits(text, intention.edits) : '';
}

function titles(text: string, cursorOn: string): string[] {
  return intentionsAt(text, text.indexOf(cursorOn)).map((intention) => intention.title);
}

const COMMAND = `<?php

final class SuspendOverdueShops
{
    public function handle(SuspendOverdueShopHandler $handler): int
    {
        $overdueShops->each(function (Customer $customer) {
            $handler->execute($customer);
            $this->line("→ {$customer->domain} suspendue");
        });

        return self::SUCCESS;
    }
}
`;

describe('a closure reading a variable it never declared', () => {
  test('offers to capture it', () => {
    expect(titles(COMMAND, '$handler->execute')).toContain('Capture $handler in the closure');
  });

  test('writes the use clause after the parameter list', () => {
    expect(apply(COMMAND, '$handler->execute', 'Capture')).toContain(
      'function (Customer $customer) use ($handler) {',
    );
  });

  test('extends the clause a closure already has', () => {
    const source = `<?php\n$items->each(function ($item) use ($logger) {\n    $logger->log($item, $prefix);\n});\n$prefix = 'x';\n`;

    expect(apply(source, '$prefix)', 'Capture')).toContain('use ($logger, $prefix)');
  });

  test('says nothing about parameters, $this and locals', () => {
    const source = `<?php\n$items->each(function ($item) {\n    $total = $item->price;\n    return $total;\n});\n`;

    expect(titles(source, '$total = ')).not.toContain('Capture $total in the closure');
    expect(titles(source, '$total = ').filter((title) => title.startsWith('Capture'))).toEqual([]);
  });

  test('says nothing about a name the file never defines elsewhere', () => {
    const source = `<?php\n$items->each(function ($item) {\n    echo $unknown;\n});\n`;

    expect(titles(source, '$unknown').filter((title) => title.startsWith('Capture'))).toEqual([]);
  });

  test('leaves a superglobal alone', () => {
    const source = `<?php\n$host = $_SERVER['HTTP_HOST'];\n$items->each(function ($item) {\n    echo $_SERVER['HTTP_HOST'];\n});\n`;

    expect(titles(source, "echo $_SERVER").filter((title) => title.startsWith('Capture'))).toEqual([]);
  });
});

describe('turning a closure into an arrow function', () => {
  test('offered when the body is a single return', () => {
    const source = `<?php\n$items->map(function (Invoice $invoice): int {\n    return $invoice->total;\n});\n`;

    expect(apply(source, 'return $invoice', 'Convert to arrow function')).toContain(
      'fn (Invoice $invoice): int => $invoice->total',
    );
  });

  test('refused for a body of several statements, whose result would change', () => {
    expect(titles(COMMAND, '$handler->execute')).not.toContain('Convert to arrow function');
  });
});
