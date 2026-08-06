import * as vscode from 'vscode';
import type { ParsedFile } from './php/parser';
import { indexedFile } from './php/phpIndex';

/** A private member nothing in the file mentions, with where its name is written. */
export interface UnusedMember {
  kind: 'method' | 'property' | 'constant';
  name: string;
  nameStart: number;
  nameEnd: number;
}

/** Magic methods are called by PHP itself, never by a line anyone wrote. */
function isMagic(name: string): boolean {
  return name.startsWith('__');
}

/**
 * True when the name is written as a string somewhere in the file.
 *
 * `[$this, 'render']`, `call_user_func`, `$this->{'render'}()` all reach a member without
 * ever writing a call the parser can see. One literal is enough to stop guessing.
 */
function isNamedInAString(text: string, name: string): boolean {
  return new RegExp(`['"\`]${name}['"\`]`).test(text);
}

/** True when the file calls or reads something whose name it computes at runtime. */
function hasDynamicAccess(text: string): boolean {
  return /->\s*[{$]|::\s*[{$]/.test(text);
}

/**
 * The private members no line of the file mentions.
 *
 * Only private ones: anything a subclass or another file could reach cannot be judged from
 * one file, and a search that has to be right would have to read the whole project on every
 * keystroke. What is private is visible here and nowhere else, which is exactly what makes
 * the answer cheap and certain.
 */
export function unusedPrivateMembers(text: string, parsed: ParsedFile): UnusedMember[] {
  if (hasDynamicAccess(text)) {
    return [];
  }

  const calledNames = new Set(parsed.calls.map((call) => call.name));
  const accessedNames = new Set(parsed.accesses.map((access) => access.name));

  const methods = parsed.methods
    .filter(
      (method) =>
        method.visibility === 'private' &&
        method.className.length > 0 &&
        !method.isAbstract &&
        !method.hasAttributes &&
        !isMagic(method.name) &&
        !calledNames.has(method.name),
    )
    .map((method) => ({
      kind: 'method' as const,
      name: method.name,
      nameStart: method.nameStart,
      nameEnd: method.nameEnd,
    }));

  const properties = parsed.properties
    .filter(
      (property) =>
        property.visibility === 'private' &&
        !property.hasAttributes &&
        !accessedNames.has(property.name),
    )
    .map((property) => ({
      kind: 'property' as const,
      name: property.name,
      nameStart: property.nameStart,
      nameEnd: property.nameEnd,
    }));

  const constants = parsed.constants
    .filter(
      (constant) =>
        constant.visibility === 'private' &&
        !constant.hasAttributes &&
        !accessedNames.has(constant.name),
    )
    .map((constant) => ({
      kind: 'constant' as const,
      name: constant.name,
      nameStart: constant.nameStart,
      nameEnd: constant.nameEnd,
    }));

  return [...methods, ...properties, ...constants].filter((member) => !isNamedInAString(text, member.name));
}

const WRITTEN_AS: Record<UnusedMember['kind'], (name: string) => string> = {
  method: (name) => `${name}()`,
  property: (name) => `$${name}`,
  constant: (name) => name,
};

/**
 * Greys out the private members nothing reaches.
 *
 * Reported as a hint rather than a warning: the answer is read from one file, and code that
 * looks unused because the call was written in a way nothing can follow is still code that
 * runs — a grey name invites a look, a warning demands one.
 */
export class UnusedMemberReporter {
  private readonly collection = vscode.languages.createDiagnosticCollection('php-toolbox');

  refresh(document: vscode.TextDocument): void {
    if (document.languageId !== 'php' || document.uri.scheme !== 'file') {
      return;
    }

    if (!vscode.workspace.getConfiguration('phpToolbox').get<boolean>('unusedMembers.enabled', true)) {
      this.collection.delete(document.uri);
      return;
    }

    const text = document.getText();
    const file = indexedFile(document.uri, text);

    this.collection.set(
      document.uri,
      unusedPrivateMembers(text, file.parsed).map((member) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(document.positionAt(member.nameStart), document.positionAt(member.nameEnd)),
          `${WRITTEN_AS[member.kind](member.name)} is private and nothing in this file uses it.`,
          vscode.DiagnosticSeverity.Hint,
        );

        diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
        diagnostic.source = 'PHP Toolbox';

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

/** Keeps the report in step with what is on screen, without parsing on every keystroke. */
export function registerUnusedMembers(): vscode.Disposable {
  const reporter = new UnusedMemberReporter();
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
      if (event.affectsConfiguration('phpToolbox.unusedMembers.enabled')) {
        vscode.workspace.textDocuments.forEach((document) => reporter.refresh(document));
      }
    }),
    new vscode.Disposable(() => pending.forEach((timer) => clearTimeout(timer))),
  ];

  vscode.workspace.textDocuments.forEach((document) => reporter.refresh(document));

  return vscode.Disposable.from(...subscriptions);
}
