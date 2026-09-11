import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Models/Configuration.php',
    `<?php

namespace App\\Models;

final class Configuration
{
    protected function formattedValue(): Attribute
    {
        return Attribute::make(get: fn (): string => $this->value);
    }
}
`,
  ],
  [
    'file:///p/app/Services/Reader.php',
    `<?php

namespace App\\Services;

use App\\Models\\Configuration;

final class Reader
{
    public function run(Configuration $configuration): string
    {
        $configuration->formatted_value = 'x';

        return $configuration->formatted_value . $configuration->formattedValue();
    }
}
`,
  ],
]);

mock.module('vscode', () => vscodeStub);
mock.module('../src/workspaceIndex', () => ({
  getIndex: async () => files,
  onDidChangeFile: () => {},
  warmIndex: () => {},
}));

const { accessKey, countMemberUsages, findMemberSites } = await import('../src/refactor/callSites');

const CLASS_NAME = 'App\\Models\\Configuration';
const accessor = { kind: 'method' as const, name: 'formattedValue', className: CLASS_NAME };
const served = { ...accessor, aliases: [{ kind: 'property' as const, name: 'formatted_value' }] };

describe('a method reached under another name', () => {
  test('counts only its calls when nothing aliases it', async () => {
    const counts = await countMemberUsages([accessor]);

    expect(counts.get(accessKey(accessor))).toEqual({ read: 1, written: 0 });
  });

  test('counts the reads and writes of the property it is served as', async () => {
    const counts = await countMemberUsages([served]);

    expect(counts.get(accessKey(served))).toEqual({ read: 2, written: 1 });
  });

  test('lists the property mentions with what they do, and the call apart', async () => {
    const search = await findMemberSites(served);

    expect(search.sites.map((site) => site.access).sort()).toEqual(['read', 'write', undefined]);
    expect(search.unresolved).toEqual([]);
  });
});
