import * as vscode from 'vscode';
import { actionsFor, NAVIGATE } from './actions';
import { cursorContext, type CursorContext } from './context';
import { indexedFile } from '../php/phpIndex';
import { intentionsAt } from '../intentions';
import { sameOccurrences, targetExpression } from '../refactor/extractExpression';
import { scopesFor } from '../php/documentAnalysis';
import { toWorkspaceEdit } from '../refactor/apply';
import type { FunctionScope } from '../php/scopes';

const EXTRACT = vscode.CodeActionKind.RefactorExtract;
const INLINE = vscode.CodeActionKind.RefactorInline;
const REWRITE = vscode.CodeActionKind.RefactorRewrite;

function action(title: string, command: string, kind: vscode.CodeActionKind, args: unknown[] = []): vscode.CodeAction {
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

/**
 * A local variable assigned exactly once is the only kind that can be inlined.
 *
 * The selection may cover the name itself — double-clicking a variable is how most people
 * point at one — but not a line around it, which is a different question entirely.
 */
function isInlinableVariable(scope: FunctionScope, start: number, end: number): boolean {
  const target = scope.uses.find((use) => use.start <= start && use.end >= start);

  if (!target || end > target.end) {
    return false;
  }

  if (target.name === 'this' || scope.params.some((param) => param.name === target.name)) {
    return false;
  }

  return scope.uses.filter((use) => use.name === target.name && use.isWrite).length === 1;
}

/**
 * What a selection can be pulled out into. These depend on the text covered rather than on
 * what the cursor names, so they are computed apart from the rule table.
 */
function selectionActions(context: CursorContext): vscode.CodeAction[] {
  const { scope, selection, file, scopes } = context;

  if (!scope) {
    return [];
  }

  const actions: vscode.CodeAction[] = [];
  const { start, end } = selection;

  if (scope.kind === 'method' && end > start && hasStatements(scope, start, end)) {
    actions.push(action('Extract method…', 'phpToolbox.extractMethod', EXTRACT));
  }

  const expression = targetExpression(file.text, selection, scopes.expressions);

  if (expression && expression.kind !== 'variable') {
    actions.push(action('Extract variable…', 'phpToolbox.extractVariable', EXTRACT));

    const occurrences = sameOccurrences(file.text, scopes.expressions, expression, {
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

    if (scope.kind === 'method') {
      if (expression.isConstant) {
        actions.push(action('Extract constant…', 'phpToolbox.extractConstant', EXTRACT, [{ isReplacingAll: true }]));
        actions.push(action('Extract constant to another class…', 'phpToolbox.extractConstantToClass', EXTRACT));
        actions.push(action('Introduce parameter…', 'phpToolbox.introduceParameter', REWRITE));
      }

      actions.push(action('Extract property…', 'phpToolbox.extractProperty', EXTRACT));
    }
  }

  if (isInlinableVariable(scope, start, end)) {
    actions.push(action('Inline variable', 'phpToolbox.inlineVariable', INLINE));
  }

  return actions;
}

/**
 * The single menu behind Alt+Enter. One pass decides what the cursor is on, one table says
 * what that allows, and the local rewrites carry their own edits.
 */
export class PhpCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    NAVIGATE,
    EXTRACT,
    INLINE,
    REWRITE,
    vscode.CodeActionKind.RefactorMove,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const text = document.getText();
    const context = cursorContext(indexedFile(document.uri, text), scopesFor(document), {
      start: document.offsetAt(range.start),
      end: document.offsetAt(range.end),
    });

    // Rewrites that apply straight away come last: the entries above are what the cursor
    // points at, and they must not move as the code around it changes.
    const intentions = intentionsAt(text, context.selection.start).map((intention) => {
      const created = new vscode.CodeAction(intention.title, REWRITE);
      created.edit = toWorkspaceEdit(document, intention.edits);

      return created;
    });

    return [...actionsFor(context), ...selectionActions(context), ...intentions];
  }
}
