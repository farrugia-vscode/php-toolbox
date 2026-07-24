import * as vscode from 'vscode';
import { scopesFor } from './php/documentAnalysis';
import { indexedFile, type IndexedFile } from './php/phpIndex';
import { scopeAt, type FileScopes, type FunctionScope } from './php/scopes';
import { sameOccurrences, targetExpression } from './refactor/extractExpression';

function action(title: string, command: string, args: unknown[] = []): vscode.CodeAction {
  const created = new vscode.CodeAction(title, vscode.CodeActionKind.Empty);
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

/** Whether the cursor is on the name of a method, either where it is declared or called. */
function isOnMethodName(file: IndexedFile, offset: number): boolean {
  return (
    file.parsed.methods.some((method) => offset >= method.nameStart && offset <= method.nameEnd) ||
    file.parsed.calls.some((call) => offset >= call.nameStart && offset <= call.nameEnd)
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

  const actions = [action('Extract variable…', 'phpToolbox.extractVariable')];
  const occurrences = sameOccurrences(text, scopes.expressions, expression, {
    start: scope.bodyStart,
    end: scope.bodyEnd,
  });

  if (occurrences.length > 1) {
    actions.push(
      action(`Extract variable (${occurrences.length} occurrences)…`, 'phpToolbox.extractVariable', [
        { isReplacingAll: true },
      ]),
    );
  }

  if (scope.kind !== 'method') {
    return actions;
  }

  if (expression.isConstant) {
    actions.push(action('Extract constant…', 'phpToolbox.extractConstant', [{ isReplacingAll: true }]));
    actions.push(action('Introduce parameter…', 'phpToolbox.introduceParameter'));
  }

  actions.push(action('Extract property…', 'phpToolbox.extractProperty'));

  return actions;
}

/**
 * Offers each refactoring only where it applies, so the quick fix menu reads like the one
 * PhpStorm opens on Alt+Enter: what you can do here, and nothing else.
 */
export class RefactorCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.Empty];

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
      actions.push(action('Extract method…', 'phpToolbox.extractMethod'));
    }

    if (scope) {
      actions.push(...expressionActions(text, scopes, scope, start, end));
    }

    if (scope && start === end && isInlinableVariable(scope, start)) {
      actions.push(action('Inline variable', 'phpToolbox.inlineVariable'));
    }

    const file = indexedFile(document.uri, text);

    if (isOnMethodName(file, start)) {
      actions.push(action('Inline method', 'phpToolbox.inlineMethod'));
      actions.push(action('Change signature…', 'phpToolbox.changeSignature'));
    }

    if (isOnMember(file, start)) {
      actions.push(action('Pull member up…', 'phpToolbox.pullMemberUp'));
      actions.push(action('Push member down…', 'phpToolbox.pushMemberDown'));
    }

    return actions;
  }
}
