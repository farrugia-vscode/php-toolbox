import { describe, expect, test } from 'bun:test';
import { intentionsAt } from '../src/intentions';
import { applyTextEdits } from '../src/refactor/plan';

function apply(text: string, cursorOn: string, title: string): string {
  const offset = text.indexOf(cursorOn);
  const intention = intentionsAt(text, offset).find((candidate) => candidate.title === title);

  return intention ? applyTextEdits(text, intention.edits) : '';
}

function titles(text: string, cursorOn: string): string[] {
  return intentionsAt(text, text.indexOf(cursorOn))
    .map((intention) => intention.title)
    .filter((title) => title.startsWith('Convert to'));
}

describe('a concatenation', () => {
  const PROBE = `<?php\n$url = 'https://'.$customer->domain.config('provisioning.probe_path');\n`;

  test('offers the two forms that can hold a call', () => {
    expect(titles(PROBE, "'https://'")).toEqual(['Convert to sprintf']);
  });

  test('becomes a sprintf, arguments in order', () => {
    expect(apply(PROBE, "'https://'", 'Convert to sprintf')).toContain(
      "$url = sprintf('https://%s%s', $customer->domain, config('provisioning.probe_path'));",
    );
  });

  test('becomes an interpolation when every part can be interpolated', () => {
    const source = `<?php\n$greeting = 'Hello ' . $user->name . '!';\n`;

    expect(titles(source, "'Hello '")).toEqual([
      'Convert to string interpolation',
      'Convert to sprintf',
    ]);
    expect(apply(source, "'Hello '", 'Convert to string interpolation')).toContain(
      '$greeting = "Hello {$user->name}!";',
    );
  });

  test('protects a literal percent, which sprintf would read as a placeholder', () => {
    const source = `<?php\n$label = '100% of ' . $total;\n`;

    expect(apply(source, "'100%", 'Convert to sprintf')).toContain(
      "$label = sprintf('100%% of %s', $total);",
    );
  });

  test('leaves a concatenation of literals alone: there is nothing to place', () => {
    expect(titles(`<?php\n$path = 'a' . 'b';\n`, "'a'")).toEqual([]);
  });

  test('refuses mixed quoting rather than rewriting escapes', () => {
    const source = `<?php\n$line = "a\\n" . $rest . 'b';\n`;

    expect(titles(source, '$rest')).toEqual([]);
  });
});

describe('an interpolated string', () => {
  const MESSAGE = `<?php\n$message = "Bonjour {$user->name}, il reste $count jours";\n`;

  test('offers both other forms', () => {
    expect(titles(MESSAGE, 'Bonjour')).toEqual(['Convert to concatenation', 'Convert to sprintf']);
  });

  test('becomes a concatenation', () => {
    expect(apply(MESSAGE, 'Bonjour', 'Convert to concatenation')).toContain(
      "$message = 'Bonjour ' . $user->name . ', il reste ' . $count . ' jours';",
    );
  });

  test('becomes a sprintf', () => {
    expect(apply(MESSAGE, 'Bonjour', 'Convert to sprintf')).toContain(
      "$message = sprintf('Bonjour %s, il reste %s jours', $user->name, $count);",
    );
  });

  test('keeps sprintf but drops concatenation when an escape would change meaning', () => {
    const source = `<?php\n$line = "total: $count\\n";\n`;

    expect(titles(source, 'total')).toEqual(['Convert to sprintf']);
    expect(apply(source, 'total', 'Convert to sprintf')).toContain(
      '$line = sprintf("total: %s\\n", $count);',
    );
  });

  test('says nothing about a string holding no expression', () => {
    expect(titles(`<?php\n$plain = "nothing here";\n`, 'nothing')).toEqual([]);
  });

  test('refuses a lone variable, whose quotes are what make it text', () => {
    expect(titles(`<?php\n$text = "$count";\n`, '$count"')).toEqual(['Convert to sprintf']);
  });
});
