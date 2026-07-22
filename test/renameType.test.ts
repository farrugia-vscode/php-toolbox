import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';
import { applyEdits, Uri } from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Handler/Front/CheckDomainHandler.php',
    `<?php

namespace App\\Handler\\Front;

final class CheckDomainHandler
{
}
`,
  ],
  [
    'file:///p/app/Http/Controllers/Front/DomainCheckController.php',
    `<?php

namespace App\\Http\\Controllers\\Front;

use App\\Handler\\Front\\CheckDomainHandler;

final class DomainCheckController
{
    public function __invoke(CheckDomainHandler $handler): void
    {
        $handler->execute();
    }
}
`,
  ],
  [
    'file:///p/app/Handler/Front/Sibling.php',
    `<?php

namespace App\\Handler\\Front;

final class Sibling
{
    public function make(): CheckDomainHandler
    {
        return new CheckDomainHandler();
    }
}
`,
  ],
  [
    'file:///p/config/services.php',
    `<?php

return [
    'handler' => 'App\\\\Handler\\\\Front\\\\CheckDomainHandler',
    'other' => \\App\\Handler\\Front\\CheckDomainHandler::class,
];
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

const HANDLER = 'App\\Handler\\Front\\CheckDomainHandler';

async function rename(oldFqn: string, newFqn: string) {
  const { edit, manual } = await buildTypeRename(oldFqn, newFqn);
  const results = new Map<string, string>();

  edit.entries().forEach(([uri, edits]) => {
    results.set(uri.path, applyEdits(files.get(uri.toString()) ?? '', edits as never));
  });

  return { results, manual, renames: (edit as unknown as vscodeStub.WorkspaceEdit).renames };
}

describe('renaming a type', () => {
  test('rewrites the declaration, the import and the file name', async () => {
    const { results, renames } = await rename(HANDLER, 'App\\Handler\\Front\\DomainChecker');

    expect(results.get('/p/app/Handler/Front/CheckDomainHandler.php')).toContain(
      'final class DomainChecker',
    );
    expect(results.get('/p/app/Http/Controllers/Front/DomainCheckController.php')).toContain(
      'use App\\Handler\\Front\\DomainChecker;',
    );
    expect(renames).toEqual([
      {
        from: 'file:///p/app/Handler/Front/CheckDomainHandler.php',
        to: 'file:///p/app/Handler/Front/DomainChecker.php',
      },
    ]);
  });

  test('rewrites neighbours that relied on the shared namespace', async () => {
    const { results } = await rename(HANDLER, 'App\\Handler\\Front\\DomainChecker');

    expect(results.get('/p/app/Handler/Front/Sibling.php')).toContain('return new DomainChecker()');
  });

  test('rewrites class strings, escaped or not', async () => {
    const { results } = await rename(HANDLER, 'App\\Handler\\Front\\DomainChecker');
    const config = results.get('/p/config/services.php') ?? '';

    expect(config).toContain("'App\\\\Handler\\\\Front\\\\DomainChecker'");
    expect(config).toContain('\\App\\Handler\\Front\\DomainChecker::class');
  });
});

describe('moving a type to another namespace', () => {
  const MOVED = 'App\\Domain\\Domain\\CheckDomainHandler';

  test('rewrites the namespace and moves the file where composer expects it', async () => {
    const { results, renames } = await rename(HANDLER, MOVED);

    expect(results.get('/p/app/Handler/Front/CheckDomainHandler.php')).toContain(
      'namespace App\\Domain\\Domain;',
    );
    expect(renames[0].to).toBe('file:///p/app/Domain/Domain/CheckDomainHandler.php');
  });

  test('adds the import neighbours now need', async () => {
    const { results } = await rename(HANDLER, MOVED);

    expect(results.get('/p/app/Handler/Front/Sibling.php')).toContain(
      'use App\\Domain\\Domain\\CheckDomainHandler;',
    );
  });

  test('updates the import of files that already had one', async () => {
    const { results } = await rename(HANDLER, MOVED);

    expect(results.get('/p/app/Http/Controllers/Front/DomainCheckController.php')).toContain(
      'use App\\Domain\\Domain\\CheckDomainHandler;',
    );
  });
});
