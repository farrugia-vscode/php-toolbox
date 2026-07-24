import * as vscode from 'vscode';
import type { Span } from '../php/scopes';
import type { TextEdit } from './editSet';
import { isRefused, type Planned } from './plan';

/** The PHP editor a refactoring command works on, with the selection as plain offsets. */
export interface EditorTarget {
  editor: vscode.TextEditor;
  document: vscode.TextDocument;
  text: string;
  selection: Span;
}

export function activeTarget(): EditorTarget | null {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return null;
  }

  const { document, selection } = editor;

  return {
    editor,
    document,
    text: document.getText(),
    selection: { start: document.offsetAt(selection.start), end: document.offsetAt(selection.end) },
  };
}

export function toWorkspaceEdit(document: vscode.TextDocument, edits: TextEdit[]): vscode.WorkspaceEdit {
  const workspaceEdit = new vscode.WorkspaceEdit();

  edits.forEach((edit) => {
    workspaceEdit.replace(
      document.uri,
      new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
      edit.text,
    );
  });

  return workspaceEdit;
}

/** Applies a plan, or tells the user why the refactoring refused to run. */
export async function applyPlan(document: vscode.TextDocument, plan: Planned): Promise<boolean> {
  if (isRefused(plan)) {
    vscode.window.showWarningMessage(plan.error);
    return false;
  }

  if (plan.warning && !(await confirm(plan.warning))) {
    return false;
  }

  await vscode.workspace.applyEdit(toWorkspaceEdit(document, plan.edits), { isRefactoring: true });
  vscode.window.showInformationMessage(plan.summary);

  return true;
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(question, { modal: true }, 'Continue');

  return answer === 'Continue';
}

const IDENTIFIER = /^[A-Za-z_]\w*$/;

/** Asks for a name, refusing anything PHP would not accept as an identifier. */
export async function askName(
  title: string,
  value: string,
  prompt?: string,
): Promise<string | null> {
  const answer = await vscode.window.showInputBox({
    title,
    value,
    prompt,
    valueSelection: [0, value.length],
    validateInput: (candidate) => (IDENTIFIER.test(candidate.trim()) ? null : 'Invalid PHP identifier.'),
  });

  return answer === undefined ? null : answer.trim();
}
