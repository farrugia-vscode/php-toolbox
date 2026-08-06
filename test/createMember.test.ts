import { describe, expect, test } from 'bun:test';
import { astOf } from '../src/php/nodeIndex';
import { parseFile } from '../src/php/parser';
import { analyzeScopes, scopeAt } from '../src/php/scopes';
import { draftText, inferParams } from '../src/refactor/createMember';

/** The arguments of the first call named `name`, as nodes. */
function argumentsOf(text: string, name: string): any[] {
  const found: any[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object' || found.length > 0) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.kind === 'call' && node.what?.offset?.name === name) {
      found.push(...(node.arguments ?? []));
      return;
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(astOf(text));

  return found;
}

function params(text: string, called: string) {
  const parsed = parseFile(text);
  const call = parsed.calls.find((candidate) => candidate.name === called);
  const scope = scopeAt(analyzeScopes(text), call?.start ?? 0, call?.start ?? 0);

  return inferParams(
    argumentsOf(text, called),
    text,
    parsed,
    scope?.params ?? [],
    parsed.declarations[0]?.fqn ?? '',
  );
}

const SOURCE = `<?php

namespace App;

final class Reminders
{
    private Mailer $mailer;

    public function run(Site $site, int $limit): void
    {
        $this->remind($site, $limit, 'daily', 2.5, true, [1, 2], new Message(), $this->mailer, $unknown);
    }
}
`;

describe('reading a signature off a call', () => {
  test('takes the type of a typed parameter and keeps its name', () => {
    expect(params(SOURCE, 'remind')[0]).toEqual({ name: 'site', type: 'Site' });
    expect(params(SOURCE, 'remind')[1]).toEqual({ name: 'limit', type: 'int' });
  });

  test('reads the type of each kind of literal', () => {
    const inferred = params(SOURCE, 'remind');

    expect(inferred[2]).toEqual({ name: 'argument3', type: 'string' });
    expect(inferred[3]).toEqual({ name: 'argument4', type: 'float' });
    expect(inferred[4]).toEqual({ name: 'argument5', type: 'bool' });
    expect(inferred[5]).toEqual({ name: 'argument6', type: 'array' });
  });

  test('names the class of a new instance', () => {
    expect(params(SOURCE, 'remind')[6]).toEqual({ name: 'argument7', type: 'Message' });
  });

  test('reads the declared type of a property, and names the parameter after it', () => {
    expect(params(SOURCE, 'remind')[7]).toEqual({ name: 'mailer', type: 'Mailer' });
  });

  test('leaves a variable it cannot type untyped rather than guessing', () => {
    expect(params(SOURCE, 'remind')[8]).toEqual({ name: 'unknown', type: null });
  });

  test('never writes the same parameter name twice', () => {
    const source = `<?php\n\nclass A\n{\n    public function run(int $row): void\n    {\n        $this->render($row, $row);\n    }\n}\n`;

    expect(params(source, 'render').map((param) => param.name)).toEqual(['row', 'row2']);
  });
});

describe('what gets written', () => {
  test('writes a private method with a body to fill in', () => {
    const draft = {
      kind: 'method' as const,
      name: 'remind',
      params: [
        { name: 'site', type: 'Site' },
        { name: 'limit', type: null },
      ],
      isSignatureOnly: false,
      visibility: 'private' as const,
      type: null,
    };

    expect(draftText(draft, '    ', '    ')).toBe(`    private function remind(Site $site, $limit)
    {
        // TODO: implement remind()
    }`);
  });

  test('writes only a signature for an interface', () => {
    const draft = {
      kind: 'method' as const,
      name: 'remind',
      params: [],
      isSignatureOnly: true,
      visibility: 'public' as const,
      type: null,
    };

    expect(draftText(draft, '    ', '    ')).toBe('    public function remind();');
  });

  test('writes a property with the type the assignment implies', () => {
    const draft = {
      kind: 'property' as const,
      name: 'attempts',
      params: [],
      isSignatureOnly: false,
      visibility: 'private' as const,
      type: 'int',
    };

    expect(draftText(draft, '    ', '    ')).toBe('    private int $attempts;');
  });
});
