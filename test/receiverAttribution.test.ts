import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';
import { applyEdits, Uri } from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Services/Tenancy/TenantProvisionerInterface.php',
    `<?php

namespace App\\Services\\Tenancy;

interface TenantProvisionerInterface
{
    public function exists(string $tenant): bool;
}
`,
  ],
  [
    'file:///p/app/Services/Tenancy/LocalTenantProvisioner.php',
    `<?php

namespace App\\Services\\Tenancy;

final readonly class LocalTenantProvisioner implements TenantProvisionerInterface
{
    public function exists(string $tenant): bool
    {
        return true;
    }

    public function ensure(string $tenant): void
    {
        if ($this->exists($tenant)) {
            return;
        }
    }
}
`,
  ],
  [
    'file:///p/app/Services/Tenancy/ProductionTenantProvisioner.php',
    `<?php

namespace App\\Services\\Tenancy;

final class ProductionTenantProvisioner implements TenantProvisionerInterface
{
    public function exists(string $tenant): bool
    {
        return false;
    }
}
`,
  ],
  [
    'file:///p/app/Services/Tenancy/TenantLocator.php',
    `<?php

namespace App\\Services\\Tenancy;

final readonly class TenantLocator
{
    public function __construct(private TenantProvisionerInterface $provisioner)
    {
    }

    public function provisioner(): TenantProvisionerInterface
    {
        return $this->provisioner;
    }
}
`,
  ],
  [
    'file:///p/app/Console/Commands/InstallTenants.php',
    `<?php

namespace App\\Console\\Commands;

use App\\Services\\Tenancy\\LocalTenantProvisioner;
use App\\Services\\Tenancy\\TenantLocator;
use App\\Services\\Tenancy\\TenantProvisionerInterface;

final class InstallTenants
{
    public function handle(TenantProvisionerInterface $provisioner, TenantLocator $locator): int
    {
        $local = new LocalTenantProvisioner();

        return (int) ($provisioner->exists('a') && $local->exists('b') && $locator->provisioner()->exists('c'));
    }

    public function check($anything): bool
    {
        return $anything->exists('d');
    }
}
`,
  ],
  [
    'file:///p/tests/Feature/Internal/CreateAdminTest.php',
    `<?php

namespace Tests\\Feature\\Internal;

use Illuminate\\Support\\Facades\\DB;

final class CreateAdminTest extends TestCase
{
    public function test_it_creates_an_admin(): void
    {
        $this->assertTrue(
            DB::connection('tenant')->table('users')->where('email', 'chauffeur@taxi-nouveau.fr')->exists(),
        );
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

const { indexedFile } = await import('../src/php/phpIndex');
const { buildMemberRename, memberAtCursor } = await import('../src/refactor/renameMember');

const LOCAL = 'file:///p/app/Services/Tenancy/LocalTenantProvisioner.php';

async function rename(uri: string, cursorOn: string, newName: string) {
  const text = files.get(uri)!;
  const file = indexedFile(Uri.parse(uri) as never, text);
  const target = await memberAtCursor(file, text.indexOf(cursorOn) + 1);
  const built = await buildMemberRename(target!, newName);
  const results = new Map<string, string>();

  (built.edit as unknown as vscodeStub.WorkspaceEdit).entries().forEach(([uriOf, edits]) => {
    results.set(uriOf.path, applyEdits(files.get(uriOf.toString()) ?? '', edits));
  });

  return { results, unresolved: built.unresolved };
}

describe('renaming a method only touches what was proven to reach it', () => {
  test('leaves a call of the same name on a dependency alone', async () => {
    const { results } = await rename(LOCAL, 'exists(string $tenant): bool', 'isExisting');

    expect(results.has('/p/tests/Feature/Internal/CreateAdminTest.php')).toBe(false);
  });

  test('renames the contract and every class bound by it', async () => {
    const { results } = await rename(LOCAL, 'exists(string $tenant): bool', 'isExisting');

    expect(results.get('/p/app/Services/Tenancy/TenantProvisionerInterface.php')).toContain(
      'public function isExisting(string $tenant): bool;',
    );
    expect(results.get('/p/app/Services/Tenancy/ProductionTenantProvisioner.php')).toContain(
      'public function isExisting(string $tenant): bool',
    );
    expect(results.get('/p/app/Services/Tenancy/LocalTenantProvisioner.php')).toContain('$this->isExisting($tenant)');
  });

  test('follows a typed parameter, an instantiation and a declared return type', async () => {
    const { results } = await rename(LOCAL, 'exists(string $tenant): bool', 'isExisting');
    const command = results.get('/p/app/Console/Commands/InstallTenants.php') ?? '';

    expect(command).toContain("$provisioner->isExisting('a')");
    expect(command).toContain("$local->isExisting('b')");
    expect(command).toContain("$locator->provisioner()->isExisting('c')");
  });

  test('reports the untyped receiver instead of guessing at it', async () => {
    const { results, unresolved } = await rename(LOCAL, 'exists(string $tenant): bool', 'isExisting');

    expect(results.get('/p/app/Console/Commands/InstallTenants.php')).toContain("$anything->exists('d')");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].file.uri.path).toBe('/p/app/Console/Commands/InstallTenants.php');
  });
});
