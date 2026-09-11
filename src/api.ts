import * as vscode from 'vscode';
import type { DeclarationKind } from './php/parser';
import { showUsagesView, type UsageEntry, type UsageListing } from './usagesView';

export type { UsageEntry, UsageGroup, UsageListing } from './usagesView';

/** The type a search is about, as another extension needs to know it. */
export interface UsageSymbol {
  name: string;
  fqn: string;
  kind: DeclarationKind;
  /** The file declaring it. */
  uri: vscode.Uri;
}

/**
 * A source of usages brought by another extension.
 *
 * What it finds joins the lens count above the declaration and gets a heading of its own
 * in the panel, next to the ones this extension reads from the code itself.
 */
export interface UsageProvider {
  /** Heading in the panel: "Dispatched", "Listened by". */
  category: string;
  find(symbol: UsageSymbol, token: vscode.CancellationToken): Promise<UsageEntry[]>;
}

/**
 * What `activate()` hands to the extensions that ask for it.
 *
 * One place counts and lists the usages of a PHP symbol; a framework extension adds what it
 * knows rather than counting again with a lens and a popup of its own.
 */
export interface PhpToolboxApi {
  registerUsageProvider(provider: UsageProvider): vscode.Disposable;
  /** Lists a search the caller ran itself in the same panel as every other listing. */
  showUsages(listing: UsageListing): Promise<void>;
}

const providers = new Set<UsageProvider>();

export function usageProviders(): UsageProvider[] {
  return [...providers];
}

export function createApi(): PhpToolboxApi {
  return {
    registerUsageProvider(provider: UsageProvider): vscode.Disposable {
      providers.add(provider);

      return new vscode.Disposable(() => providers.delete(provider));
    },
    showUsages: showUsagesView,
  };
}
