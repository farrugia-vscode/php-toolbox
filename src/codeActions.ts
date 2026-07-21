import * as vscode from 'vscode';

const DECLARATION = /^\s*(?:final\s+|readonly\s+)*(abstract\s+)?(class|interface|trait|enum)\s+\w+/;

/** What the file declares drives the wording: an interface is looked up for its implementations. */
function title(line: string): string | null {
  const match = DECLARATION.exec(line);
  if (!match) {
    return null;
  }

  const isAbstract = match[1] !== undefined;
  const kind = match[2];

  if (kind === 'interface' || (kind === 'class' && isAbstract)) {
    return 'Find implementations';
  }
  if (kind === 'trait') {
    return 'Find trait users';
  }

  return 'Find usages';
}

/**
 * Offers the search in the quick fix menu, so it is reachable with the shortcut people
 * already press, without stealing a binding of its own.
 */
export class UsagesCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.Empty];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    // Only on the declaration line: offered everywhere, it gets in the way while
    // writing unrelated code inside the class.
    const label = title(document.lineAt(range.start.line).text);
    if (!label) {
      return [];
    }

    const action = new vscode.CodeAction(label, vscode.CodeActionKind.Empty);
    action.command = {
      command: 'phpToolbox.findUsages',
      title: label,
    };

    return [action];
  }
}
