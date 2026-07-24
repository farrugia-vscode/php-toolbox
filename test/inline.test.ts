import { describe, expect, test } from 'bun:test';
import { parseFile } from '../src/php/parser';
import { analyzeScopes } from '../src/php/scopes';
import { inlineCall, inlineTarget, removeMethod } from '../src/refactor/inlineMethod';
import { planInlineVariable } from '../src/refactor/inlineVariable';
import { applyTextEdits, isRefused } from '../src/refactor/plan';

const REPORT = `<?php

namespace App;

final class Report
{
    public function render(array $rows): string
    {
        $header = $this->title('Sales');

        return $header . ' ' . count($rows);
    }

    public function short(): string
    {
        return 'x' . $this->title('Sales');
    }

    private function title(string $label): string
    {
        return strtoupper($label) . ':';
    }
}
`;

const LOGGER = `<?php

namespace App;

final class Logger
{
    public function run(array $rows): void
    {
        $this->announce(count($rows));
    }

    private function announce(int $count): void
    {
        $line = sprintf('%d rows', $count);
        echo $line;
    }
}
`;

function methodNamed(text: string, name: string) {
  const method = parseFile(text).methods.find((candidate) => candidate.name === name);

  if (!method) {
    throw new Error(`no method ${name}`);
  }

  return method;
}

function inlineAll(text: string, name: string) {
  const target = inlineTarget(text, methodNamed(text, name), true);

  if ('error' in target) {
    return { error: target.error, result: '' };
  }

  const parsed = parseFile(text);
  const scopes = analyzeScopes(text);
  const edits = parsed.calls
    .filter((call) => call.name === name)
    .map((call) => inlineCall(text, scopes, call, target))
    .filter((edit) => !('error' in edit));

  return { error: null, result: applyTextEdits(text, [...edits, removeMethod(text, methodNamed(text, name))] as never) };
}

describe('inlining a method', () => {
  test('replaces a one-expression body at every call site', () => {
    const { result } = inlineAll(REPORT, 'title');

    expect(result).toContain("        $header = strtoupper('Sales') . ':';");
    expect(result).toContain("        return 'x' . (strtoupper('Sales') . ':');");
    expect(result).not.toContain('private function title');
  });

  test('moves a body of several statements into the calling line', () => {
    const { result } = inlineAll(LOGGER, 'announce');

    expect(result).toContain("        $line = sprintf('%d rows', count($rows));\n        echo $line;");
    expect(result).not.toContain('private function announce');
  });

  test('refuses a public method that a subclass could override', () => {
    const open = REPORT.replace('final class Report', 'class Report').replace(
      'private function title',
      'public function title',
    );

    expect(inlineTarget(open, methodNamed(open, 'title'), false)).toEqual({
      error: 'title() is public and could be overridden; inlining it is not safe.',
    });
  });

  test('refuses a method that returns from more than one place', () => {
    const branching = REPORT.replace(
      "        return strtoupper($label) . ':';",
      "        if ($label === '') {\n            return '';\n        }\n\n        return strtoupper($label);",
    );

    expect(inlineTarget(branching, methodNamed(branching, 'title'), true)).toEqual({
      error: 'title() returns from more than one place.',
    });
  });
});

describe('inlining a variable', () => {
  test('replaces the reads and drops the assignment', () => {
    const plan = planInlineVariable(REPORT, REPORT.indexOf('$header = ') + 2);
    const result = isRefused(plan) ? '' : applyTextEdits(REPORT, plan.edits);

    expect(result).toContain("        return $this->title('Sales') . ' ' . count($rows);");
    expect(result).not.toContain('$header =');
  });

  test('refuses a variable assigned twice', () => {
    const twice = REPORT.replace(
      "        return $header . ' ' . count($rows);",
      "        $header = $header . '!';\n\n        return $header;",
    );
    const plan = planInlineVariable(twice, twice.indexOf('$header = ') + 2);

    expect(isRefused(plan) && plan.error).toBe('$header is assigned 2 times and cannot be inlined.');
  });
});
