import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';
import { applyEdits, Uri } from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Contracts/Checker.php',
    `<?php

namespace App\\Contracts;

interface Checker
{
}
`,
  ],
  [
    'file:///p/app/Concerns/Checks.php',
    `<?php

namespace App\\Concerns;

trait Checks
{
}
`,
  ],
  [
    'file:///p/app/Enums/Status.php',
    `<?php

namespace App\\Enums;

enum Status: string
{
    case Draft = 'draft';
}
`,
  ],
  [
    'file:///p/app/Handler/Check.php',
    `<?php

namespace App\\Handler;

use App\\Concerns\\Checks;
use App\\Contracts\\Checker;
use App\\Enums\\Status;

final class Check implements Checker
{
    use Checks;

    public function status(): Status
    {
        return Status::Draft;
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
mock.module('../src/php/psr4', () => ({
  directoryForNamespace: async (namespace: string) =>
    Uri.file(`/p/app/${namespace.replace(/^App/, '').split('\\').filter(Boolean).join('/')}`),
  namespaceForFile: async () => null,
  getPsr4Roots: async () => [],
  forgetPsr4Roots: () => {},
}));

const { buildTypeRename } = await import('../src/refactor/renameType');

async function rename(oldFqn: string, newFqn: string) {
  const { edit } = await buildTypeRename(oldFqn, newFqn);
  const results = new Map<string, string>();

  edit.entries().forEach(([uri, edits]) => {
    results.set(uri.path, applyEdits(files.get(uri.toString()) ?? '', edits as never));
  });

  return { results, renames: (edit as unknown as vscodeStub.WorkspaceEdit).renames };
}

describe('every declaration kind is renamed the same way', () => {
  test('interface, at its declaration and its implements clause', async () => {
    const { results, renames } = await rename('App\\Contracts\\Checker', 'App\\Contracts\\Verifier');

    expect(results.get('/p/app/Contracts/Checker.php')).toContain('interface Verifier');
    expect(results.get('/p/app/Handler/Check.php')).toContain('implements Verifier');
    expect(results.get('/p/app/Handler/Check.php')).toContain('use App\\Contracts\\Verifier;');
    expect(renames[0].to).toBe('file:///p/app/Contracts/Verifier.php');
  });

  test('trait, at its declaration and its use clause', async () => {
    const { results } = await rename('App\\Concerns\\Checks', 'App\\Concerns\\Verifies');
    const user = results.get('/p/app/Handler/Check.php') ?? '';

    expect(results.get('/p/app/Concerns/Checks.php')).toContain('trait Verifies');
    expect(user).toContain('use App\\Concerns\\Verifies;');
    expect(user).toContain('    use Verifies;');
  });

  test('enum, at its declaration, its return type and its case access', async () => {
    const { results } = await rename('App\\Enums\\Status', 'App\\Enums\\State');
    const user = results.get('/p/app/Handler/Check.php') ?? '';

    expect(results.get('/p/app/Enums/Status.php')).toContain('enum State: string');
    expect(user).toContain('public function status(): State');
    expect(user).toContain('return State::Draft;');
  });

  test('moving a trait to another namespace fixes both use statements', async () => {
    const { results, renames } = await rename('App\\Concerns\\Checks', 'App\\Support\\Checks');
    const user = results.get('/p/app/Handler/Check.php') ?? '';

    expect(results.get('/p/app/Concerns/Checks.php')).toContain('namespace App\\Support;');
    expect(user).toContain('use App\\Support\\Checks;');
    expect(user).toContain('    use Checks;');
    expect(renames[0].to).toBe('file:///p/app/Support/Checks.php');
  });
});
