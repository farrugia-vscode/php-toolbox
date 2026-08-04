import * as vscode from 'vscode';
import type { Member } from '../types';
import { membersOf, mixinMembersOf, receiverClassAt } from '../mixinResolution';

const COMPLETION_KIND: Partial<Record<vscode.SymbolKind, vscode.CompletionItemKind>> = {
  [vscode.SymbolKind.Method]: vscode.CompletionItemKind.Method,
  [vscode.SymbolKind.Property]: vscode.CompletionItemKind.Property,
  [vscode.SymbolKind.Field]: vscode.CompletionItemKind.Property,
};

/** Magic methods are part of how the forwarding works, not something to call by hand. */
function isOfferable(member: Member, line: string): boolean {
  return !member.name.startsWith('__') && !/\b(?:private|protected)\b/.test(line);
}

function toCompletionItem(member: Member, kind: vscode.CompletionItemKind): vscode.CompletionItem {
  const label = member.name.replace(/^\$/, '');
  const item = new vscode.CompletionItem(label, kind);

  item.detail = [member.detail, member.className.split('\\').pop()].filter(Boolean).join('  ·  ');

  if (kind === vscode.CompletionItemKind.Method) {
    item.insertText = new vscode.SnippetString(`${label}($0)`);
  }

  return item;
}

async function toCompletionItems(members: Member[]): Promise<vscode.CompletionItem[]> {
  const documents = new Map<string, vscode.TextDocument>();
  const items: vscode.CompletionItem[] = [];

  for (const member of members) {
    const kind = COMPLETION_KIND[member.kind];

    if (kind === undefined) {
      continue;
    }

    const key = member.uri.toString();
    const document =
      documents.get(key) ?? (await vscode.workspace.openTextDocument(member.uri));
    documents.set(key, document);

    const line = document.lineAt(Math.min(member.range.start.line, document.lineCount - 1)).text;

    if (isOfferable(member, line)) {
      items.push(toCompletionItem(member, kind));
    }
  }

  return items;
}

/**
 * Completes the members a class only receives through a `@mixin`, which Intelephense
 * drops: `$site->` offers no model attribute, because ide-helper writes them on a separate
 * `IdeHelperSite` the annotation points to, and `$invoice->customer()->exists()` offers
 * nothing either, because `Relation` forwards to the query builder through
 * `@mixin \Illuminate\Database\Eloquent\Builder<TRelatedModel>`.
 *
 * When the server does type the receiver, only what the mixins add is offered — the rest
 * is already in its own list. When it does not, its list is empty and the whole class is
 * offered instead.
 */
export class MixinCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const receiver = await receiverClassAt(document, document.offsetAt(position));

    if (!receiver || token.isCancellationRequested) {
      return undefined;
    }

    const members = receiver.isKnownToServer
      ? await mixinMembersOf(receiver.target)
      : [...(await membersOf(receiver.target)).values()];

    return toCompletionItems(members);
  }
}
