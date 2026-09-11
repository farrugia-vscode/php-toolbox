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

/** A member of a class, as another extension needs to know it to say how else the code reaches it. */
export interface MemberSymbol {
  kind: 'method' | 'property' | 'staticProperty' | 'constant';
  name: string;
  className: string;
  /** The return type as the method writes it, null when it writes none or is not a method. */
  returnType: string | null;
}

/** Another name the code reaches a member by, and how: a method a framework serves as a property. */
export interface MemberAlias {
  kind: 'method' | 'property';
  name: string;
}

/**
 * What a framework adds to a member: an Eloquent accessor `formattedValue(): Attribute` is
 * never called, it is read and written as `->formatted_value`. Its mentions under that
 * name join the count above the method and its listing.
 */
export interface MemberAliasProvider {
  aliasesOf(member: MemberSymbol): MemberAlias[];
}

/**
 * What `activate()` hands to the extensions that ask for it.
 *
 * One place counts and lists the usages of a PHP symbol; a framework extension adds what it
 * knows rather than counting again with a lens and a popup of its own.
 */
export interface PhpToolboxApi {
  registerUsageProvider(provider: UsageProvider): vscode.Disposable;
  registerMemberAliasProvider(provider: MemberAliasProvider): vscode.Disposable;
  /**
   * Functions returning an instance of the class named by their first argument, the way
   * a container does: with `app` registered, `app(Customer::class)->save()` is a call on a
   * Customer, and `$customer = app(Customer::class)` types the variable.
   */
  registerInstanceFactories(functions: string[]): vscode.Disposable;
  /** Lists a search the caller ran itself in the same panel as every other listing. */
  showUsages(listing: UsageListing): Promise<void>;
}

const usageSources = new Set<UsageProvider>();
const aliasSources = new Set<MemberAliasProvider>();
const factorySources = new Set<string[]>();
const changed = new vscode.EventEmitter<void>();

/** Fires when an extension brings a source or takes one away: what a lens counted is no longer the whole answer. */
export const onDidChangeProviders = changed.event;

export function usageProviders(): UsageProvider[] {
  return [...usageSources];
}

/** Every other name the registered extensions reach the member by. */
export function memberAliases(member: MemberSymbol): MemberAlias[] {
  return [...aliasSources].flatMap((provider) => provider.aliasesOf(member));
}

/** True when the function is known to build the class it is handed; PHP does not mind the case of a function name. */
export function isInstanceFactory(callee: string): boolean {
  const name = callee.replace(/^\\/, '').toLowerCase();

  return [...factorySources].some((functions) => functions.some((candidate) => candidate.toLowerCase() === name));
}

function register<T>(sources: Set<T>, provider: T): vscode.Disposable {
  sources.add(provider);
  changed.fire();

  return new vscode.Disposable(() => {
    sources.delete(provider);
    changed.fire();
  });
}

export function createApi(): PhpToolboxApi {
  return {
    registerUsageProvider: (provider: UsageProvider) => register(usageSources, provider),
    registerMemberAliasProvider: (provider: MemberAliasProvider) => register(aliasSources, provider),
    registerInstanceFactories: (functions: string[]) => register(factorySources, functions),
    showUsages: showUsagesView,
  };
}
