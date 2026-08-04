import * as vscode from 'vscode';
import { IMPLEMENTATION_CATEGORIES, TRAIT_USER_CATEGORIES } from './usages';
import type { UsagesSearch } from './findUsages';

const DECLARATION = /^\s*(?:final\s+|readonly\s+)*(abstract\s+)?(class|interface|trait|enum)\s+\w+/;

/** The search a declaration line asks for, with the wording that goes with it. */
interface DeclaredSearch extends UsagesSearch {
  title: string;
}

/**
 * What the file declares drives the search: asking an interface for its implementations
 * has to answer with implementations, not with every mention of its name.
 */
function searchFor(line: string): DeclaredSearch | null {
  const match = DECLARATION.exec(line);
  if (!match) {
    return null;
  }

  const isAbstract = match[1] !== undefined;
  const kind = match[2];

  if (kind === 'interface' || (kind === 'class' && isAbstract)) {
    return {
      title: 'Find implementations',
      categories: IMPLEMENTATION_CATEGORIES,
      label: 'implementations',
    };
  }
  if (kind === 'trait') {
    return { title: 'Find trait users', categories: TRAIT_USER_CATEGORIES, label: 'trait users' };
  }

  return { title: 'Find usages' };
}

function action(
  title: string,
  command: string,
  kind = vscode.CodeActionKind.Empty,
  ...args: unknown[]
): vscode.CodeAction {
  const created = new vscode.CodeAction(title, kind);
  created.command = { command, title, arguments: args };

  return created;
}

/**
 * Offers the searches and refactorings in the quick fix menu, so they are reachable with
 * the shortcut people already press, without stealing a binding of their own.
 */
export class UsagesCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.Empty,
    vscode.CodeActionKind.Refactor,
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
    const line = document.lineAt(range.start.line).text;
    const search = searchFor(line);

    if (!search) {
      return [];
    }

    const { title, ...narrowed } = search;
    const actions = [
      action(title, 'phpToolbox.findUsages', vscode.CodeActionKind.Empty, narrowed),
    ];

    // The narrowed search answers the question that was asked; the full list stays one
    // entry away, since a type is also read through what merely mentions it.
    if (search.categories) {
      actions.push(action('Find all usages', 'phpToolbox.findUsages'));
    }

    actions.push(
      action('Rename…', 'phpToolbox.renameType', vscode.CodeActionKind.RefactorRewrite),
      action('Move class…', 'phpToolbox.moveClass', vscode.CodeActionKind.RefactorMove),
      action('Safe delete', 'phpToolbox.safeDelete', vscode.CodeActionKind.RefactorRewrite),
    );

    if (/\bclass\s+\w/.test(line) && !/\babstract\b/.test(line)) {
      actions.push(action('Extract interface…', 'phpToolbox.extractInterface', vscode.CodeActionKind.RefactorExtract));
    }

    if (/\b(class|trait)\s+\w/.test(line)) {
      actions.push(action('Generate constructor…', 'phpToolbox.generateConstructor', vscode.CodeActionKind.Refactor));
    }

    if (/\b(implements|extends)\b/.test(line)) {
      actions.push(action('Implement missing methods…', 'phpToolbox.implementMissing', vscode.CodeActionKind.Refactor));
    }

    return actions;
  }
}
