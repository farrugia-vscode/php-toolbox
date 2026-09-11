import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Support/BookingQrCode.php',
    `<?php

namespace App\\Support;

final class BookingQrCode
{
    public function execute(string $url, string $ink): string
    {
        return $url . $ink;
    }
}
`,
  ],
  [
    'file:///p/app/Services/TenantStorage.php',
    `<?php

namespace App\\Services;

final class TenantStorage
{
    public function execute(string $domain): void
    {
    }
}
`,
  ],
  [
    'file:///p/app/Http/Controllers/ShowOutreachController.php',
    `<?php

namespace App\\Http\\Controllers;

use App\\Support\\BookingQrCode;

final class ShowOutreachController
{
    public function __invoke(BookingQrCode $qrCode, string $url): array
    {
        return array_map(fn (array $ink): array => [...$ink, 'svg' => $qrCode->execute($url, $ink['value'])], []);
    }

    public function later(BookingQrCode $qrCode, string $url): callable
    {
        return function () use ($qrCode, $url): string {
            return $qrCode->execute($url, 'black');
        };
    }

    public function execute(string $url, string $ink): string
    {
        return array_map(fn (self $controller): string => $controller->execute($url, $ink), [$this])[0];
    }
}
`,
  ],
  [
    'file:///p/tests/TenantStorageTest.php',
    `<?php

use App\\Services\\TenantStorage;

$storage = app(TenantStorage::class);
$storage->execute('a');
app(TenantStorage::class)->execute('b');
resolve(TenantStorage::class)->execute('c');
`,
  ],
]);

mock.module('vscode', () => vscodeStub);
mock.module('../src/workspaceIndex', () => ({
  getIndex: async () => files,
  onDidChangeFile: () => {},
  warmIndex: () => {},
}));

const { createApi } = await import('../src/api');
const { findMemberSites } = await import('../src/refactor/callSites');

const qrCodeExecute = { kind: 'method' as const, name: 'execute', className: 'App\\Support\\BookingQrCode' };
const controllerExecute = { kind: 'method' as const, name: 'execute', className: 'App\\Http\\Controllers\\ShowOutreachController' };
const storageExecute = { kind: 'method' as const, name: 'execute', className: 'App\\Services\\TenantStorage' };

const lineOf = (site: { file: { text: string }; nameStart: number }) =>
  site.file.text.slice(site.file.text.lastIndexOf('\n', site.nameStart) + 1, site.file.text.indexOf('\n', site.nameStart)).trim();

describe('a variable captured by a nested function', () => {
  test('is typed by the parameter of the method holding the arrow function or the closure', async () => {
    const search = await findMemberSites(qrCodeExecute);

    expect(search.sites.map(lineOf)).toEqual([
      "return array_map(fn (array $ink): array => [...$ink, 'svg' => $qrCode->execute($url, $ink['value'])], []);",
      "return $qrCode->execute($url, 'black');",
    ]);
    // What is left unresolved is the other class's, whose factory nothing has declared yet.
    expect(search.unresolved.map(lineOf)).toEqual([
      "$storage->execute('a');",
      "app(TenantStorage::class)->execute('b');",
      "resolve(TenantStorage::class)->execute('c');",
    ]);
  });

  test('is typed by the enclosing class when the parameter says self', async () => {
    const search = await findMemberSites(controllerExecute);

    expect(search.sites.map(lineOf)).toEqual([
      'return array_map(fn (self $controller): string => $controller->execute($url, $ink), [$this])[0];',
    ]);
  });

  test('is not mistaken for a member of the same name on another class', async () => {
    const search = await findMemberSites(storageExecute);

    expect(search.unresolved.map(lineOf)).not.toContain("return $qrCode->execute($url, 'black');");
  });
});

describe('a call on what a factory function builds', () => {
  test('stays unresolved while nothing says what the function returns', async () => {
    const search = await findMemberSites(storageExecute);

    expect(search.sites).toEqual([]);
    expect(search.unresolved.map(lineOf)).toEqual([
      "$storage->execute('a');",
      "app(TenantStorage::class)->execute('b');",
      "resolve(TenantStorage::class)->execute('c');",
    ]);
  });

  test('is a call on the class named, once the function is registered as a factory', async () => {
    const registration = createApi().registerInstanceFactories(['app']);

    try {
      const search = await findMemberSites(storageExecute);

      expect(search.sites.map(lineOf)).toEqual(["$storage->execute('a');", "app(TenantStorage::class)->execute('b');"]);
      expect(search.unresolved.map(lineOf)).toEqual(["resolve(TenantStorage::class)->execute('c');"]);
    } finally {
      registration.dispose();
    }
  });

  test('forgets the factories an extension took away', async () => {
    createApi().registerInstanceFactories(['app', 'resolve']).dispose();

    expect((await findMemberSites(storageExecute)).sites).toEqual([]);
  });
});
