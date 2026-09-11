import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { createApi, memberAliases, usageProviders } = await import('../src/api');

const accessor = { kind: 'method' as const, name: 'formattedValue', className: 'App\\Models\\Configuration', returnType: 'Attribute' };

describe('what another extension registers', () => {
  test('answers with the aliases its providers give, until they are disposed', () => {
    const registration = createApi().registerMemberAliasProvider({
      aliasesOf: (member) => (member.returnType === 'Attribute' ? [{ kind: 'property', name: 'formatted_value' }] : []),
    });

    expect(memberAliases(accessor)).toEqual([{ kind: 'property', name: 'formatted_value' }]);
    expect(memberAliases({ ...accessor, returnType: 'string' })).toEqual([]);

    registration.dispose();

    expect(memberAliases(accessor)).toEqual([]);
  });

  test('lists a usage provider until it is disposed', () => {
    const provider = { category: 'Listened by', find: async () => [] };
    const registration = createApi().registerUsageProvider(provider);

    expect(usageProviders()).toEqual([provider]);

    registration.dispose();

    expect(usageProviders()).toEqual([]);
  });
});
