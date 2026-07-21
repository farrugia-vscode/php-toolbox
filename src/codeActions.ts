import * as vscode from 'vscode';

const DECLARES = /^\s*(?:final\s+|abstract\s+|readonly\s+)*(?:class|interface|trait|enum)\s+\w+/m;

/**
 * Offers the search in the quick fix menu, so it is reachable with the shortcut people
 * already press, without stealing a binding of its own.
 */
export class UsagesCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.Empty];

  provideCodeActions(document: vscode.TextDocument): vscode.CodeAction[] {
    if (!DECLARES.test(document.getText())) {
      return [];
    }

    const action = new vscode.CodeAction('Find usages', vscode.CodeActionKind.Empty);
    action.command = {
      command: 'phpToolbox.findUsages',
      title: 'Find usages',
    };

    return [action];
  }
}
