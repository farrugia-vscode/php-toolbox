import * as vscode from 'vscode';

const DECLARATION = /^\s*(?:final\s+|readonly\s+)*(abstract\s+)?(class|interface|trait|enum)\s+\w+/;

/** What the file declares drives the wording: an interface is looked up for its implementations. */
function usagesTitle(line: string): string | null {
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

function action(title: string, command: string, kind = vscode.CodeActionKind.Empty): vscode.CodeAction {
  const created = new vscode.CodeAction(title, kind);
  created.command = { command, title };

  return created;
}

/**
 * Offers the searches and refactorings in the quick fix menu, so they are reachable with
 * the shortcut people already press, without stealing a binding of their own.
 */
export class UsagesCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.Empty,
    vscode.CodeActionKind.RefactorExtract,
    vscode.CodeActionKind.RefactorRewrite,
    vscode.CodeActionKind.RefactorMove,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    // Only on the declaration line: offered everywhere, they get in the way while
    // writing unrelated code inside the class.
    const usages = usagesTitle(document.lineAt(range.start.line).text);

    if (!usages) {
      return [];
    }

    const line = document.lineAt(range.start.line).text;
    const actions = [
      action(usages, 'phpToolbox.findUsages'),
      action('Rename…', 'phpToolbox.renameType', vscode.CodeActionKind.RefactorRewrite),
      action('Move class…', 'phpToolbox.moveClass', vscode.CodeActionKind.RefactorMove),
    ];

    if (/\bclass\s+\w/.test(line) && !/\babstract\b/.test(line)) {
      actions.push(action('Extract interface…', 'phpToolbox.extractInterface', vscode.CodeActionKind.RefactorExtract));
    }

    return actions;
  }
}
