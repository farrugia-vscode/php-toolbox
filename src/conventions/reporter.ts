import * as vscode from 'vscode';
import { indexedFile } from '../php/phpIndex';
import {
  conventionIssues,
  DEFAULT_CONTRACT_METHODS,
  type ConventionIssue,
  type ConventionRule,
} from './rules';

const SOURCE = 'PHP Toolbox';

/** One setting per rule: a convention one project holds is not one another holds. */
const SETTINGS: Record<ConventionRule, string> = {
  booleanPrefix: 'conventions.booleanPrefix.enabled',
  actionVerb: 'conventions.actionVerb.enabled',
  immutableService: 'conventions.immutableService.enabled',
  braces: 'conventions.braces.enabled',
  emDash: 'conventions.emDash.enabled',
};

function settings() {
  return vscode.workspace.getConfiguration('phpToolbox');
}

function isEnabled(rule: ConventionRule): boolean {
  return settings().get<boolean>(SETTINGS[rule], true);
}

/** The issues of a document, already filtered by what the project asked to be told about. */
export function issuesIn(document: vscode.TextDocument): ConventionIssue[] {
  const text = document.getText();
  const file = indexedFile(document.uri, text);

  return conventionIssues(text, file.parsed, {
    contractMethods: settings().get<string[]>('conventions.contractMethods', DEFAULT_CONTRACT_METHODS),
  }).filter((issue) => isEnabled(issue.rule));
}

/**
 * Reported as hints rather than warnings.
 *
 * A convention is what the project agreed to read, not what stops it running: a name that
 * departs from it is worth seeing where it is written, and worth nothing in a panel listing
 * everything wrong with the code.
 */
export class ConventionReporter {
  private readonly collection = vscode.languages.createDiagnosticCollection('php-toolbox-conventions');

  refresh(document: vscode.TextDocument): void {
    if (document.languageId !== 'php' || document.uri.scheme !== 'file') {
      return;
    }

    this.collection.set(
      document.uri,
      issuesIn(document).map((issue) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)),
          issue.message,
          vscode.DiagnosticSeverity.Hint,
        );

        diagnostic.source = SOURCE;
        diagnostic.code = issue.rule;

        return diagnostic;
      }),
    );
  }

  forget(document: vscode.TextDocument): void {
    this.collection.delete(document.uri);
  }

  dispose(): void {
    this.collection.dispose();
  }
}

/** Long enough that a burst of keystrokes parses the file once, short enough to feel live. */
const REPARSE_DELAY_MS = 300;

export function registerConventions(): vscode.Disposable {
  const reporter = new ConventionReporter();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();

    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        reporter.refresh(document);
      }, REPARSE_DELAY_MS),
    );
  };

  const subscriptions = [
    reporter,
    vscode.workspace.onDidOpenTextDocument((document) => reporter.refresh(document)),
    vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearTimeout(pending.get(document.uri.toString()));
      pending.delete(document.uri.toString());
      reporter.forget(document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('phpToolbox.conventions')) {
        vscode.workspace.textDocuments.forEach((document) => reporter.refresh(document));
      }
    }),
    new vscode.Disposable(() => pending.forEach((timer) => clearTimeout(timer))),
  ];

  vscode.workspace.textDocuments.forEach((document) => reporter.refresh(document));

  return vscode.Disposable.from(...subscriptions);
}
