import * as vscode from 'vscode';
import type { ConventionIssue } from './rules';
import { issuesIn } from './reporter';

const RENAME_TITLE = 'Rename to follow the convention…';

function editingAction(
  document: vscode.TextDocument,
  issue: ConventionIssue & { fix: { kind: 'edits'; edits: Array<{ start: number; end: number; text: string }> } },
  title: string,
): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

  action.edit = new vscode.WorkspaceEdit();

  issue.fix.edits.forEach((edit) =>
    action.edit!.replace(
      document.uri,
      new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
      edit.text,
    ),
  );

  return action;
}

/**
 * A name is never fixed by the editor alone: which verb replaces `to`, which prefix a
 * boolean takes, is the decision the convention leaves to whoever wrote the code. The fix
 * opens the rename with the cursor already placed, and stops there.
 */
function renameAction(
  document: vscode.TextDocument,
  issue: ConventionIssue,
): vscode.CodeAction {
  const action = new vscode.CodeAction(RENAME_TITLE, vscode.CodeActionKind.QuickFix);

  action.command = {
    command: 'phpToolbox.revealAt',
    title: RENAME_TITLE,
    arguments: [document.uri, document.positionAt(issue.start), 'phpToolbox.rename', []],
  };

  return action;
}

export class ConventionCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const cursor = document.offsetAt(range.start);

    return issuesIn(document)
      .filter((issue) => cursor >= issue.start && cursor <= issue.end)
      .flatMap((issue) => {
        if (issue.fix?.kind === 'rename') {
          return [renameAction(document, issue)];
        }

        if (issue.fix?.kind === 'edits') {
          return [
            editingAction(
              document,
              issue as ConventionIssue & { fix: { kind: 'edits'; edits: Array<{ start: number; end: number; text: string }> } },
              issue.message,
            ),
          ];
        }

        return [];
      });
  }
}
