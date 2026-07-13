import * as vscode from 'vscode';
import { KIND_ICON, findClassLikeSymbols, pickEnclosingClass } from './classSymbols';
import { InheritanceResolver } from './inheritanceResolver';
import type { Member } from './types';

interface MemberQuickPickItem extends vscode.QuickPickItem {
  member: Member;
}

async function show(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const symbols =
    (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      editor.document.uri,
    )) ?? [];
  const classSymbols = findClassLikeSymbols(symbols);
  if (classSymbols.length === 0) {
    vscode.window.showInformationMessage('No class found in this file.');
    return;
  }

  const classSymbol = pickEnclosingClass(classSymbols, editor.selection.active);
  let members = new Map<string, Member>();
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Resolving inherited symbols…' },
    async () => {
      members = await new InheritanceResolver().resolve(editor.document.uri, classSymbol);
    },
  );

  const ownName = classSymbol.name.split('\\').pop();
  const items: MemberQuickPickItem[] = [...members.values()]
    .sort((first, second) => first.name.localeCompare(second.name))
    .map((member) => {
      const icon = KIND_ICON[member.kind] ?? 'symbol-misc';
      const from = member.className.split('\\').pop();
      return {
        label: `$(${icon}) ${member.name}`,
        description: from === ownName ? '' : from,
        detail: member.detail || '',
        member,
      };
    });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${ownName} — ${items.length} members (incl. inherited)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(picked.member.uri);
  const opened = await vscode.window.showTextDocument(document);
  opened.selection = new vscode.Selection(picked.member.range.start, picked.member.range.start);
  opened.revealRange(picked.member.range, vscode.TextEditorRevealType.InCenter);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('phpInheritedSymbols.show', show));
}

export function deactivate(): void {}
