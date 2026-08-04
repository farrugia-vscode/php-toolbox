import * as vscode from 'vscode';
import { intentionsAt } from './intentions';
import { scopesFor } from './php/documentAnalysis';
import { indexedFile, type IndexedFile } from './php/phpIndex';
import { scopeAt, type FileScopes, type FunctionScope } from './php/scopes';
import { toWorkspaceEdit } from './refactor/apply';
import { sameOccurrences, targetExpression } from './refactor/extractExpression';
import { localAt } from './refactor/renameLocal';

/**
 * Opens the whole code action menu, groups and all.
 *
 * `quickFix` alone hides anything typed as a refactoring, and the refactor menu hides the
 * quick fixes; an empty kind matches every group, which is the menu Alt+Enter is expected
 * to open.
 */
export async function showRefactorings(): Promise<void> {
  try {
    await vscode.commands.executeCommand('editor.action.codeAction', { kind: '', apply: 'never' });
  } catch {
    await vscode.commands.executeCommand('editor.action.quickFix');
  }
}

const EXTRACT = vscode.CodeActionKind.RefactorExtract;
const INLINE = vscode.CodeActionKind.RefactorInline;
const REWRITE = vscode.CodeActionKind.RefactorRewrite;
const MOVE = vscode.CodeActionKind.RefactorMove;

/**
 * The kind decides the group the action shows up under — Extract, Inline, Rewrite, Move —
 * which is what turns a flat list of a dozen entries into a menu you can read.
 */
function action(
  title: string,
  command: string,
  kind: vscode.CodeActionKind,
  args: unknown[] = [],
): vscode.CodeAction {
  const created = new vscode.CodeAction(title, kind);
  created.command = { command, title, arguments: args };

  return created;
}

/** Statements the selection touches, which is what an extraction would move. */
function hasStatements(scope: FunctionScope, start: number, end: number): boolean {
  return scope.blocks.some(
    (block) =>
      block.start <= start &&
      block.end >= end &&
      block.statements.some((statement) => statement.end > start && statement.start < end),
  );
}

/** A local variable assigned exactly once is the only kind that can be inlined. */
function isInlinableVariable(scope: FunctionScope, offset: number): boolean {
  const target = scope.uses.find((use) => use.start <= offset && use.end >= offset);

  if (!target || target.name === 'this' || scope.params.some((param) => param.name === target.name)) {
    return false;
  }

  return scope.uses.filter((use) => use.name === target.name && use.isWrite).length === 1;
}

/** A method with no body of its own is answered somewhere else. */
function isOnAbstractMethod(file: IndexedFile, offset: number): boolean {
  return file.parsed.methods.some(
    (method) => offset >= method.nameStart && offset <= method.nameEnd && method.isAbstract,
  );
}

/** Whether the cursor is on the name of a method, either where it is declared or called. */
function isOnMethodName(file: IndexedFile, offset: number): boolean {
  return (
    file.parsed.methods.some((method) => offset >= method.nameStart && offset <= method.nameEnd) ||
    file.parsed.calls.some((call) => offset >= call.nameStart && offset <= call.nameEnd)
  );
}

/** Anywhere a member is named: its declaration, a call to it, or a read of it. */
function isOnMemberName(file: IndexedFile, offset: number): boolean {
  const declared = [...file.parsed.methods, ...file.parsed.properties, ...file.parsed.constants];

  return (
    declared.some((member) => offset >= member.nameStart && offset <= member.nameEnd) ||
    file.parsed.calls.some((call) => offset >= call.nameStart && offset <= call.nameEnd) ||
    file.parsed.accesses.some((access) => offset >= access.nameStart && offset <= access.nameEnd)
  );
}

function isOnMember(file: IndexedFile, offset: number): boolean {
  const members = [...file.parsed.methods, ...file.parsed.properties, ...file.parsed.constants];

  return members.some((member) => offset >= member.start && offset <= member.end);
}

function expressionActions(
  text: string,
  scopes: FileScopes,
  scope: FunctionScope,
  start: number,
  end: number,
): vscode.CodeAction[] {
  const expression = targetExpression(text, { start, end }, scopes.expressions);

  if (!expression || expression.kind === 'variable') {
    return [];
  }

  const actions = [action('Extract variable…', 'phpToolbox.extractVariable', EXTRACT)];
  const occurrences = sameOccurrences(text, scopes.expressions, expression, {
    start: scope.bodyStart,
    end: scope.bodyEnd,
  });

  if (occurrences.length > 1) {
    actions.push(
      action(`Extract variable (${occurrences.length} occurrences)…`, 'phpToolbox.extractVariable', EXTRACT, [
        { isReplacingAll: true },
      ]),
    );
  }

  if (scope.kind !== 'method') {
    return actions;
  }

  if (expression.isConstant) {
    actions.push(action('Extract constant…', 'phpToolbox.extractConstant', EXTRACT, [{ isReplacingAll: true }]));
    actions.push(action('Extract constant to another class…', 'phpToolbox.extractConstantToClass', EXTRACT));
    actions.push(action('Introduce parameter…', 'phpToolbox.introduceParameter', REWRITE));
  }

  actions.push(action('Extract property…', 'phpToolbox.extractProperty', EXTRACT));

  return actions;
}

/**
 * Offers each refactoring only where it applies, so the quick fix menu reads like the one
 * PhpStorm opens on Alt+Enter: what you can do here, and nothing else.
 */
export class RefactorCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.Empty, EXTRACT, INLINE, REWRITE, MOVE];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const text = document.getText();
    const scopes = scopesFor(document);
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    const scope = scopeAt(scopes, start, end);
    const actions: vscode.CodeAction[] = [];

    if (scope && scope.kind === 'method' && end > start && hasStatements(scope, start, end)) {
      actions.push(action('Extract method…', 'phpToolbox.extractMethod', EXTRACT));
    }

    if (scope) {
      actions.push(...expressionActions(text, scopes, scope, start, end));
    }

    if (scope && start === end && isInlinableVariable(scope, start)) {
      actions.push(action('Inline variable', 'phpToolbox.inlineVariable', INLINE));
    }

    // Local rewrites carry their edits, so picking one applies it straight away.
    intentionsAt(text, start).forEach((intention) => {
      const created = new vscode.CodeAction(intention.title, REWRITE);
      created.edit = toWorkspaceEdit(document, intention.edits);
      actions.push(created);
    });

    const file = indexedFile(document.uri, text);

    if (isOnMemberName(file, start)) {
      actions.push(action('Rename…', 'phpToolbox.renameMember', REWRITE));
    } else if (localAt(scopes, text, start)) {
      actions.push(action('Rename…', 'phpToolbox.renameLocal', REWRITE));
    }

    if (isOnAbstractMethod(file, start)) {
      actions.push(action('Find implementations', 'phpToolbox.findImplementations', vscode.CodeActionKind.Empty));
    }

    if (isOnMethodName(file, start)) {
      actions.push(action('Inline method', 'phpToolbox.inlineMethod', INLINE));
    }

    if (isOnMember(file, start)) {
      actions.push(action('Safe delete', 'phpToolbox.safeDelete', REWRITE));
    }

    if (isOnMethodName(file, start)) {
      actions.push(action('Change signature…', 'phpToolbox.changeSignature', REWRITE));
    }

    if (isOnMethodName(file, start)) {
      actions.push(action('Move method to another class…', 'phpToolbox.moveMethod', MOVE));
    }

    if (isOnMember(file, start)) {
      actions.push(action('Pull member up…', 'phpToolbox.pullMemberUp', MOVE));
      actions.push(action('Push member down…', 'phpToolbox.pushMemberDown', MOVE));
    }

    return actions;
  }
}
