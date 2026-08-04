import * as vscode from 'vscode';
import type { Member } from './types';
import { MEMBER_KINDS } from './classSymbols';
import { resolveTypeName } from './classResolution';
import { docblockRange, parseDocblockMembers, parseTypeReferences } from './typeReferences';

const MAX_DEPTH = 25;

/**
 * Walks a class's inheritance graph (parents, interfaces, traits) and collects
 * every member declared along the way. One instance = one resolution: state
 * (`seen`, `members`) lives for the duration of a single {@link resolve} call.
 */
export class InheritanceResolver {
  private readonly seen = new Set<string>();
  private readonly members = new Map<string, Member>();

  async resolve(uri: vscode.Uri, classSymbol: vscode.DocumentSymbol): Promise<Map<string, Member>> {
    await this.collect(uri, classSymbol, 0);
    return this.members;
  }

  private async collect(uri: vscode.Uri, classSymbol: vscode.DocumentSymbol, depth: number): Promise<void> {
    const key = uri.toString() + '#' + classSymbol.name;
    if (depth > MAX_DEPTH || this.seen.has(key)) {
      return;
    }
    this.seen.add(key);

    this.collectOwnMembers(uri, classSymbol);

    const document = await vscode.workspace.openTextDocument(uri);

    this.collectDocblockMembers(uri, document, classSymbol);

    const { names } = parseTypeReferences(document, classSymbol);

    for (const name of names) {
      await this.collectParent(document, classSymbol, name, depth);
    }
  }

  /** Members declared through `@property` / `@method` annotations on the class. */
  private collectDocblockMembers(
    uri: vscode.Uri,
    document: vscode.TextDocument,
    classSymbol: vscode.DocumentSymbol,
  ): void {
    for (const member of parseDocblockMembers(document, classSymbol)) {
      if (this.members.has(member.name)) {
        continue;
      }

      const position = new vscode.Position(member.line, 0);

      this.members.set(member.name, {
        name: member.name,
        detail: member.detail,
        kind: member.kind,
        className: classSymbol.name,
        uri,
        range: new vscode.Range(position, position),
      });
    }
  }

  private collectOwnMembers(uri: vscode.Uri, classSymbol: vscode.DocumentSymbol): void {
    for (const child of classSymbol.children ?? []) {
      if (!MEMBER_KINDS.has(child.kind) || this.members.has(child.name)) {
        continue;
      }
      this.members.set(child.name, {
        name: child.name,
        detail: child.detail,
        kind: child.kind,
        className: classSymbol.name,
        uri,
        range: child.selectionRange,
      });
    }
  }

  private async collectParent(
    document: vscode.TextDocument,
    classSymbol: vscode.DocumentSymbol,
    name: string,
    depth: number,
  ): Promise<void> {
    // `@mixin` targets live in the docblock, above the class declaration.
    const classLine = classSymbol.selectionRange.start.line;
    const fromLine = docblockRange(document, classLine)?.[0] ?? classLine;

    const parent = await resolveTypeName(document, name, fromLine, classSymbol.range.end.line);

    if (parent) {
      await this.collect(parent.uri, parent.symbol, depth + 1);
    }
  }
}
