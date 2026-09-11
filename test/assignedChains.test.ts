import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Models/Configuration.php',
    `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

final class Configuration extends Model
{
    public function save(): bool
    {
        return true;
    }
}
`,
  ],
  [
    'file:///p/app/Services/ConfigurationReader.php',
    `<?php

namespace App\\Services;

use App\\Models\\Configuration;

final class ConfigurationReader
{
    public function getRecord(string $key): Configuration
    {
        return new Configuration();
    }
}
`,
  ],
  [
    'file:///p/app/Handlers/UpdatePricingHandler.php',
    `<?php

namespace App\\Handlers;

use App\\Services\\ConfigurationReader;

final class UpdatePricingHandler
{
    public function __construct(private readonly ConfigurationReader $configurationReader)
    {
    }

    public function execute(): void
    {
        $configuration = $this->configurationReader->getRecord('pricing');
        $configuration->save();
    }
}
`,
  ],
  [
    'file:///p/tests/PricingTest.php',
    `<?php

use App\\Models\\Configuration;
use App\\Services\\ConfigurationReader;

function reader(): ConfigurationReader
{
    return new ConfigurationReader();
}

$fromFactory = app(ConfigurationReader::class)->getRecord('pricing');
$fromFactory->save();

$fromHelper = reader()->getRecord('pricing');
$fromHelper->save();

$fromBuilder = Configuration::query()->where('key', 'pricing')->first();
$fromBuilder->save();

$other = Configuration::query()->get();
$other->save();
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

const save = { kind: 'method' as const, name: 'save', className: 'App\\Models\\Configuration' };

const lineOf = (site: { file: { text: string }; nameStart: number }) =>
  site.file.text.slice(site.file.text.lastIndexOf('\n', site.nameStart) + 1, site.file.text.indexOf('\n', site.nameStart)).trim();

describe('a variable assigned from a chain', () => {
  test('is typed by following the chain from where it was assigned', async () => {
    const search = await findMemberSites(save);

    expect(search.sites.map(lineOf)).toContain('$configuration->save();');
  });

  test('starts from what a factory builds once the factory is registered', async () => {
    const registration = createApi().registerInstanceFactories(['app']);

    try {
      expect((await findMemberSites(save)).sites.map(lineOf)).toContain('$fromFactory->save();');
    } finally {
      registration.dispose();
    }
  });

  test('starts from what a plain function of the project declares it returns', async () => {
    expect((await findMemberSites(save)).sites.map(lineOf)).toContain('$fromHelper->save();');
  });

  test('stays foreign where the chain leaves the project and nothing types it', async () => {
    const search = await findMemberSites(save);

    expect(search.sites.map(lineOf)).not.toContain('$fromBuilder->save();');
    expect(search.unresolved.map(lineOf)).not.toContain('$fromBuilder->save();');
  });

  test('is typed by a member type provider where the class declares nothing', async () => {
    const asked: string[] = [];
    const registration = createApi().registerMemberTypeProvider({
      typeOf: (member) => {
        asked.push(`${member.owner}::${member.name}${member.isCall ? '()' : ''}`);

        return member.lineage.includes('Illuminate\\Database\\Eloquent\\Model') && ['query', 'where', 'first'].includes(member.name)
          ? member.owner
          : null;
      },
    });

    try {
      const search = await findMemberSites(save);

      expect(search.sites.map(lineOf)).toContain('$fromBuilder->save();');
      expect(search.sites.map(lineOf)).not.toContain('$other->save();');
      expect(asked).toContain('App\\Models\\Configuration::query()');
    } finally {
      registration.dispose();
    }
  });
});
