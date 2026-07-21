import * as vscode from 'vscode';
import { KIND_ICON, findClassLikeSymbols, pickEnclosingClass } from './classSymbols';
import { UsagesCodeActionProvider } from './codeActions';
import { showUsages } from './findUsages';
import { InheritanceResolver } from './inheritanceResolver';
import type { Member } from './types';
import { warmIndex } from './workspaceIndex';

interface MemberQuickPickItem extends vscode.QuickPickItem {
  member?: Member;
}

/**
 * Own members first, then one group per parent class or trait: a flat list of a few
 * hundred inherited members buries the handful that belong to the class being read.
 */
function groupByOrigin(members: Member[], ownName: string | undefined): MemberQuickPickItem[] {
  const origins = [...new Set(members.map((member) => member.className.split('\\').pop() ?? ''))].sort(
    (first, second) => {
      if (first === ownName) {
        return -1;
      }
      if (second === ownName) {
        return 1;
      }
      return first.localeCompare(second);
    },
  );

  return origins.flatMap((origin) => {
    const inOrigin = members
      .filter((member) => (member.className.split('\\').pop() ?? '') === origin)
      .sort((first, second) => first.name.localeCompare(second.name));

    const separator: MemberQuickPickItem = {
      label: origin === ownName ? `${origin} (${inOrigin.length})` : `inherited from ${origin} (${inOrigin.length})`,
      kind: vscode.QuickPickItemKind.Separator,
    };

    return [
      separator,
      ...inOrigin.map((member) => ({
        label: `$(${KIND_ICON[member.kind] ?? 'symbol-misc'}) ${member.name}`,
        description: member.detail || '',
        member,
      })),
    ];
  });
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
  const items = groupByOrigin([...members.values()], ownName);

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${ownName} — ${members.size} members (incl. inherited)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked?.member) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(picked.member.uri);
  const opened = await vscode.window.showTextDocument(document);
  opened.selection = new vscode.Selection(picked.member.range.start, picked.member.range.start);
  opened.revealRange(picked.member.range, vscode.TextEditorRevealType.InCenter);
}

export function activate(context: vscode.ExtensionContext): void {
  warmIndex();

  context.subscriptions.push(
    vscode.commands.registerCommand('phpToolbox.inheritedSymbols', show),
    vscode.commands.registerCommand('phpToolbox.findUsages', showUsages),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', language: 'php' },
      new UsagesCodeActionProvider(),
      { providedCodeActionKinds: UsagesCodeActionProvider.providedCodeActionKinds },
    ),
  );
}

export function deactivate(): void {}
