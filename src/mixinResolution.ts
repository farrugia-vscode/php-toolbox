import * as vscode from 'vscode';
import type { Member } from './types';
import { InheritanceResolver } from './inheritanceResolver';
import { findAssignment, findParameterType, type Receiver } from './php/assignments';
import { findDeclaredType } from './php/declaredType';
import { findReceiverMember, findReceiverVariable } from './php/receiverChain';
import { mixinMembers } from './completion/mixinMembers';
import { normalizeDefinition } from './typeReferences';
import { onDidChangeFile } from './workspaceIndex';
import { pickEnclosingClass, findClassLikeSymbols } from './classSymbols';
import { classSymbolAt, resolveTypeAt, resolveTypeName, type ResolvedClass } from './classResolution';

/** The class a `->` hangs off, and whether the language server got there on its own. */
export interface Receiverclass {
  target: ResolvedClass;
  /**
   * True when the server already types the receiver: it then offers the ordinary members
   * itself, and only what a `@mixin` adds is worth contributing.
   */
  isKnownToServer: boolean;
}

/** A chain no one writes by hand, and a guard against a cycle of aliases. */
const MAX_HOPS = 5;

/** Resolving a hierarchy is expensive enough that no keystroke should redo it. */
const allMembers = new Map<string, Map<string, Member>>();
const fromMixins = new Map<string, Member[]>();

let isQuerying = false;

onDidChangeFile(() => {
  allMembers.clear();
  fromMixins.clear();
});

/**
 * True while a server request is in flight for us. Our own hover and definition providers
 * answer the same requests, so without this they would call themselves.
 */
export function isQueryingServer(): boolean {
  return isQuerying;
}

async function askServer<T>(query: () => Thenable<T>): Promise<T> {
  isQuerying = true;
  try {
    return await query();
  } finally {
    isQuerying = false;
  }
}

function keyOf(target: ResolvedClass): string {
  return `${target.uri.toString()}#${target.symbol.name}`;
}

/** Every member of a class, inherited and annotated ones included. */
export async function membersOf(target: ResolvedClass): Promise<Map<string, Member>> {
  const key = keyOf(target);
  const cached = allMembers.get(key);

  if (cached) {
    return cached;
  }

  const members = await new InheritanceResolver().resolve(target.uri, target.symbol);
  allMembers.set(key, members);

  return members;
}

/** Only what a `@mixin` brings in — what the server leaves out. */
export async function mixinMembersOf(target: ResolvedClass): Promise<Member[]> {
  const key = keyOf(target);
  const cached = fromMixins.get(key);

  if (cached) {
    return cached;
  }

  const members = await mixinMembers(target);
  fromMixins.set(key, members);

  return members;
}

/**
 * The class named by a docblock type: `\App\Models\Customer|null` is a Customer, and a
 * relation written `BelongsTo<Customer, $this>` is read as the relation itself — the
 * property that mirrors it carries the useful type.
 */
export function classNameOf(type: string): string | null {
  const first = type
    .split('|')
    .map((part) => part.trim())
    .find((part) => part !== '' && part !== 'null');

  if (first === undefined) {
    return null;
  }

  const name = first.replace(/^\\/, '').replace(/\[\]$/, '').replace(/<.*$/, '');

  return /^[A-Za-z_][\w\\]*$/.test(name) ? name : null;
}

/** The type the server reports for the variable at `position`, or null when it has none. */
async function typeFromServer(
  document: vscode.TextDocument,
  position: vscode.Position,
  name: string,
): Promise<string | null> {
  const hovers = await askServer(() =>
    vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      position,
    ),
  );

  // Servers word it differently — `@var Site $site`, `@param Site $site`, or the bare
  // declaration — so the type is read from whatever sits just before the variable.
  const pattern = new RegExp(`(?:@(?:var|param)\\s+)?([\\w\\\\|<>\\[\\],\\s]+?)\\s+\\$${name}\\b`);

  for (const hover of hovers ?? []) {
    for (const content of hover.contents) {
      const text = typeof content === 'string' ? content : content.value;
      const declared = pattern.exec(text);

      if (declared && declared[1].trim() !== 'mixed') {
        return declared[1].trim();
      }
    }
  }

  return null;
}

/** The class of `$this`, for an assignment that reads a member off it. */
async function enclosingClass(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<ResolvedClass | null> {
  const symbols = findClassLikeSymbols(
    (await askServer(() =>
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      ),
    )) ?? [],
  );

  if (symbols.length === 0) {
    return null;
  }

  return { uri: document.uri, symbol: pickEnclosingClass(symbols, position) };
}

/** The class a member of `owner` holds, read off its declared or annotated type. */
export async function typeOfMember(owner: ResolvedClass, name: string): Promise<ResolvedClass | null> {
  const members = await membersOf(owner);
  const member = members.get(`$${name}`) ?? members.get(name);
  const className = member ? classNameOf(member.detail) : null;

  if (!member || !className) {
    return null;
  }

  const declaring = await vscode.workspace.openTextDocument(member.uri);
  const line = member.range.start.line;

  return resolveTypeName(declaring, className, line, line);
}

async function resolveReceiver(
  document: vscode.TextDocument,
  position: vscode.Position,
  receiver: Receiver,
  hops: number,
): Promise<ResolvedClass | null> {
  if (receiver.kind === 'this') {
    return enclosingClass(document, position);
  }

  const resolved = await resolveVariable(document, position, receiver.name, hops + 1);

  return resolved?.target ?? null;
}

/**
 * The class held by `$name` at `position`: what the server reports, and failing that what
 * the closest assignment above says. The fallback is what carries a model attribute the
 * server dropped with its `@mixin`.
 */
export async function resolveVariable(
  document: vscode.TextDocument,
  position: vscode.Position,
  name: string,
  hops = 0,
): Promise<Receiverclass | null> {
  if (hops > MAX_HOPS) {
    return null;
  }

  const reported = await typeFromServer(document, position, name);
  const className = reported ? classNameOf(reported) : null;

  if (className) {
    const target = await resolveTypeName(document, className, 0, document.lineCount - 1);

    if (target) {
      return { target, isKnownToServer: true };
    }
  }

  const text = document.getText();
  const offset = document.offsetAt(position);

  // A typed parameter says what it holds without any inference, and a server that stays
  // silent on hover is no reason to lose it.
  const declared = classNameOf(findParameterType(text, name, offset) ?? '');

  if (declared) {
    const target = await resolveTypeName(document, declared, 0, document.lineCount - 1);

    if (target) {
      return { target, isKnownToServer: reported !== null };
    }
  }

  const assigned = findAssignment(text, name, offset);

  if (!assigned) {
    return null;
  }

  if (assigned.kind === 'instantiation') {
    const target = await resolveTypeName(document, assigned.className, 0, document.lineCount - 1);

    return target ? { target, isKnownToServer: false } : null;
  }

  if (assigned.kind === 'staticMember') {
    const owner = await resolveTypeName(document, assigned.className, 0, document.lineCount - 1);
    const target = owner ? await typeOfMember(owner, assigned.name) : null;

    return target ? { target, isKnownToServer: false } : null;
  }

  const owner = await resolveReceiver(document, position, assigned.receiver, hops);
  const target = owner ? await typeOfMember(owner, assigned.name) : null;

  return target ? { target, isKnownToServer: false } : null;
}

/** The class of a `foo()->` chain, resolved from the declared type of the member called. */
async function resolveCallChain(
  document: vscode.TextDocument,
  offset: number,
): Promise<Receiverclass | null> {
  const receiver = findReceiverMember(document.getText(), offset);

  if (!receiver) {
    return null;
  }

  const definition = normalizeDefinition(
    await askServer(() =>
      vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        'vscode.executeDefinitionProvider',
        document.uri,
        document.positionAt(receiver.offset),
      ),
    ),
  );

  if (!definition) {
    return null;
  }

  const declaring = await vscode.workspace.openTextDocument(definition.uri);
  const declaredType = findDeclaredType(declaring.getText(), declaring.offsetAt(definition.position));

  if (!declaredType) {
    return null;
  }

  // A fluent `@return $this` sends the chain back to the class the method was found in,
  // which is where its own `@mixin` hangs — `$query->where()->…` keeps the builder.
  if (declaredType.isSelfType) {
    const declaringClass = await classSymbolAt(definition);

    return declaringClass ? { target: declaringClass, isKnownToServer: true } : null;
  }

  const target = await resolveTypeAt(
    definition.uri,
    declaring.positionAt(declaredType.offset),
    declaredType.name,
  );

  return target ? { target, isKnownToServer: true } : null;
}

/**
 * The class whose members a `->` at `offset` can reach, whether it hangs off a call
 * (`$invoice->customer()->…`) or off a variable (`$site->…`).
 */
export async function receiverClassAt(
  document: vscode.TextDocument,
  offset: number,
): Promise<Receiverclass | null> {
  const text = document.getText();
  const variable = findReceiverVariable(text, offset);

  if (variable) {
    return resolveVariable(document, document.positionAt(variable.offset), variable.name);
  }

  return resolveCallChain(document, offset);
}
