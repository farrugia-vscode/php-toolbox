import * as vscode from 'vscode';
import { KIND_ICON, findClassLikeSymbols, pickEnclosingClass } from './classSymbols';
import { MixinCompletionProvider } from './completion/mixinCompletionProvider';
import { PhpFoldingRangeProvider, PhpSelectionRangeProvider } from './editorRanges';
import { PhpDeclarationProvider, PhpTypeDefinitionProvider } from './typeNavigation';
import { ImportCodeActionProvider } from './refactor/importSymbol';
import { PhpTypeHierarchyProvider } from './typeHierarchy';
import { PhpInlayHintsProvider } from './inlayHints';
import { PhpCodeLensProvider, revealAt } from './codeLens';
import { MixinDefinitionProvider, MixinHoverProvider } from './mixinMemberProviders';
import { findImplementations } from './findImplementations';
import { showUsages } from './findUsages';
import { showMemberUsages } from './findMemberUsages';
import { InheritanceResolver } from './inheritanceResolver';
import { PathCompletionProvider } from './paths/pathCompletionProvider';
import { PathLinkProvider } from './paths/pathLinkProvider';
import { forgetPsr4Roots } from './php/psr4';
import { CreateFromUsageCodeActionProvider } from './refactor/createFromUsage';
import { extractExpression, extractMethod } from './refactor/extractCommands';
import { extractConstantToClass } from './refactor/extractConstantTo';
import { extractInterface } from './refactor/extractInterface';
import { extractTrait } from './refactor/extractTrait';
import { generateConstructor, implementMissing, overrideMethod } from './refactor/generate';
import { goToTest } from './refactor/goToTest';
import { sortMembers } from './refactor/sortMembers';
import { inlineMethod, inlineVariable } from './refactor/inlineCommands';
import { moveMethod } from './refactor/moveMethod';
import { copyClass, moveClass, registerFileMoveSync } from './refactor/moveNamespace';
import { pullMemberUp, pushMemberDown } from './refactor/moveMembers';
import { PhpRenameProvider, renameType } from './refactor/renameProvider';
import { renameMember } from './refactor/renameMember';
import { rename, renameLocal } from './refactor/renameCommands';
import { safeDelete } from './refactor/safeDelete';
import { changeSignature, introduceParameter } from './refactor/signatureCommands';
import { PhpCodeActionProvider } from './menu/provider';
import type { Member } from './types';
import { registerUnusedMembers } from './unusedMembers';
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
      // The origin is repeated on each row on purpose: VS Code drops separators as
      // soon as the user types, and the group headers go with them.
      ...inOrigin.map((member) => ({
        label: `$(${KIND_ICON[member.kind] ?? 'symbol-misc'}) ${member.name}`,
        description: [member.detail, origin === ownName ? '' : origin]
          .filter(Boolean)
          .join('  ·  '),
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

  // The autoload map decides where a moved class must land, so a stale copy misplaces files.
  const composer = vscode.workspace.createFileSystemWatcher('**/composer.json');
  composer.onDidChange(forgetPsr4Roots);
  composer.onDidCreate(forgetPsr4Roots);

  context.subscriptions.push(
    vscode.commands.registerCommand('phpToolbox.inheritedSymbols', show),
    vscode.commands.registerCommand('phpToolbox.findUsages', showUsages),
    vscode.commands.registerCommand('phpToolbox.findMemberUsages', showMemberUsages),
    vscode.commands.registerCommand('phpToolbox.findImplementations', findImplementations),
    vscode.commands.registerCommand('phpToolbox.moveClass', moveClass),
    vscode.commands.registerCommand('phpToolbox.copyClass', copyClass),
    vscode.commands.registerCommand('phpToolbox.renameType', renameType),
    vscode.commands.registerCommand('phpToolbox.renameMember', renameMember),
    vscode.commands.registerCommand('phpToolbox.renameLocal', renameLocal),
    vscode.commands.registerCommand('phpToolbox.rename', rename),
    vscode.commands.registerCommand('phpToolbox.safeDelete', safeDelete),
    vscode.commands.registerCommand('phpToolbox.extractMethod', extractMethod),
    vscode.commands.registerCommand('phpToolbox.extractVariable', (options?: { isReplacingAll?: boolean }) =>
      extractExpression('variable', options?.isReplacingAll ?? false),
    ),
    vscode.commands.registerCommand('phpToolbox.extractConstant', (options?: { isReplacingAll?: boolean }) =>
      extractExpression('constant', options?.isReplacingAll ?? true),
    ),
    vscode.commands.registerCommand('phpToolbox.extractProperty', () => extractExpression('property')),
    vscode.commands.registerCommand('phpToolbox.extractConstantToClass', extractConstantToClass),
    vscode.commands.registerCommand('phpToolbox.inlineVariable', inlineVariable),
    vscode.commands.registerCommand('phpToolbox.inlineMethod', inlineMethod),
    vscode.commands.registerCommand('phpToolbox.changeSignature', changeSignature),
    vscode.commands.registerCommand('phpToolbox.introduceParameter', introduceParameter),
    vscode.commands.registerCommand('phpToolbox.extractInterface', extractInterface),
    vscode.commands.registerCommand('phpToolbox.extractTrait', extractTrait),
    vscode.commands.registerCommand('phpToolbox.implementMissing', implementMissing),
    vscode.commands.registerCommand('phpToolbox.overrideMethod', overrideMethod),
    vscode.commands.registerCommand('phpToolbox.sortMembers', sortMembers),
    vscode.commands.registerCommand('phpToolbox.goToTest', goToTest),
    vscode.commands.registerCommand('phpToolbox.generateConstructor', generateConstructor),
    vscode.commands.registerCommand('phpToolbox.moveMethod', moveMethod),
    vscode.commands.registerCommand('phpToolbox.pullMemberUp', pullMemberUp),
    vscode.commands.registerCommand('phpToolbox.pushMemberDown', pushMemberDown),
    vscode.languages.registerRenameProvider({ scheme: 'file', language: 'php' }, new PhpRenameProvider()),
    registerUnusedMembers(),
    registerFileMoveSync(),
    composer,
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', language: 'php' },
      new PhpCodeActionProvider(),
      { providedCodeActionKinds: PhpCodeActionProvider.providedCodeActionKinds },
    ),
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'file', language: 'php' },
      new MixinCompletionProvider(),
      '>',
    ),
    vscode.languages.registerHoverProvider(
      { scheme: 'file', language: 'php' },
      new MixinHoverProvider(),
    ),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', language: 'php' },
      new ImportCodeActionProvider(),
      { providedCodeActionKinds: ImportCodeActionProvider.providedCodeActionKinds },
    ),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', language: 'php' },
      new CreateFromUsageCodeActionProvider(),
      { providedCodeActionKinds: CreateFromUsageCodeActionProvider.providedCodeActionKinds },
    ),
    vscode.languages.registerFoldingRangeProvider(
      { scheme: 'file', language: 'php' },
      new PhpFoldingRangeProvider(),
    ),
    vscode.languages.registerSelectionRangeProvider(
      { scheme: 'file', language: 'php' },
      new PhpSelectionRangeProvider(),
    ),
    vscode.languages.registerTypeDefinitionProvider(
      { scheme: 'file', language: 'php' },
      new PhpTypeDefinitionProvider(),
    ),
    vscode.languages.registerDeclarationProvider(
      { scheme: 'file', language: 'php' },
      new PhpDeclarationProvider(),
    ),
    vscode.languages.registerTypeHierarchyProvider(
      { scheme: 'file', language: 'php' },
      new PhpTypeHierarchyProvider(),
    ),
    vscode.languages.registerInlayHintsProvider(
      { scheme: 'file', language: 'php' },
      new PhpInlayHintsProvider(),
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file', language: 'php' },
      new PhpCodeLensProvider(),
    ),
    vscode.commands.registerCommand('phpToolbox.revealAt', revealAt),
    vscode.languages.registerDefinitionProvider(
      { scheme: 'file', language: 'php' },
      new MixinDefinitionProvider(),
    ),
    vscode.languages.registerDocumentLinkProvider(
      { scheme: 'file', language: 'php' },
      new PathLinkProvider(),
    ),
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'file', language: 'php' },
      new PathCompletionProvider(),
      '/',
    ),
  );
}

export function deactivate(): void {}
