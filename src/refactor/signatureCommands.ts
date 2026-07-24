import * as vscode from 'vscode';
import { indexedFile, type IndexedFile } from '../php/phpIndex';
import { analyzeScopes, scopeAt } from '../php/scopes';
import { activeTarget, askName, confirm, withProgress } from './apply';
import { findCallSites, methodAtCursor, relatedMethods, type MethodLocation } from './callSites';
import { EditSet } from './editSet';
import { targetExpression } from './extractExpression';
import {
  callEdit,
  declarationEdit,
  describeParams,
  parseParams,
  promotedLoss,
  type ParamSpec,
} from './signature';

/** Collects edits per file, then turns them into one workspace edit. */
class WorkspaceEdits {
  private readonly byFile = new Map<IndexedFile, EditSet>();

  add(file: IndexedFile, edit: { start: number; end: number; text: string }): void {
    const edits = this.byFile.get(file) ?? new EditSet();
    edits.add(edit);
    this.byFile.set(file, edits);
  }

  build(): { edit: vscode.WorkspaceEdit; files: number } {
    const edit = new vscode.WorkspaceEdit();

    this.byFile.forEach((edits, file) => {
      edits.all().forEach((textEdit) => {
        edit.replace(file.uri, file.mapper.range(textEdit.start, textEdit.end), textEdit.text);
      });
    });

    return { edit, files: this.byFile.size };
  }
}

/** Applies a new parameter list to the method, its relatives and everything that calls it. */
async function applySignature(
  location: MethodLocation,
  specs: ParamSpec[],
  extras: Array<{ file: IndexedFile; edit: { start: number; end: number; text: string } }> = [],
): Promise<void> {
  const { method } = location;
  const edits = new WorkspaceEdits();

  extras.forEach((extra) => edits.add(extra.file, extra.edit));
  const declarations: MethodLocation[] = [location, ...(await relatedMethods(method))];

  declarations.forEach((declaration) => edits.add(declaration.file, declarationEdit(declaration.method, specs)));

  const { sites } = await withProgress(`Updating the calls to ${method.name}()…`, () => findCallSites(method));
  const refusals: string[] = [];

  sites.forEach((site) => {
    const edit = callEdit(site.file.text, site.call, method, specs);

    if ('error' in edit) {
      refusals.push(edit.error);
      return;
    }

    edits.add(site.file, edit);
  });

  if (refusals.length > 0 && !(await confirm(`${[...new Set(refusals)].join('; ')}. Apply the change anyway?`))) {
    return;
  }

  const { edit, files } = edits.build();
  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(
    `${method.name}() — ${sites.length - refusals.length} call(s) updated across ${files} file(s).`,
  );
}

/**
 * Rewrites the parameter list as a single line, keeping the `#n` tags so a parameter can be
 * moved or renamed without losing the arguments callers already pass for it.
 */
export async function changeSignature(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const location = await methodAtCursor(file, editor.document.offsetAt(editor.selection.active));

  if (!location) {
    vscode.window.showWarningMessage('Place the cursor on a method name or on a call to one.');
    return;
  }

  const current = describeParams(location.method);
  const answer = await vscode.window.showInputBox({
    title: `Change signature of ${location.method.name}()`,
    value: current,
    prompt: 'Reorder, rename or retype parameters. Keep the #n tag to carry the arguments over; drop it to add a new one.',
  });

  if (answer === undefined || answer.trim() === current) {
    return;
  }

  const specs = parseParams(answer.trim());

  if ('error' in specs) {
    vscode.window.showWarningMessage(specs.error);
    return;
  }

  const missing = specs.filter((spec) => spec.originIndex === null && spec.defaultText === null);

  for (const spec of missing) {
    const value = await vscode.window.showInputBox({
      title: `Value callers should pass for $${spec.name}`,
      value: 'null',
    });

    if (value === undefined) {
      return;
    }

    spec.argumentText = value.trim();
  }

  const lost = promotedLoss(location.method, specs);

  if (lost.length > 0) {
    const names = lost.map((param) => `$${param.name}`).join(', ');

    if (!(await confirm(`${names} declare properties through constructor promotion. Remove them?`))) {
      return;
    }
  }

  await applySignature(location, specs);
}

/**
 * Turns a hard coded value into a parameter, so the decision moves to the callers.
 *
 * Only an expression that stands on its own can move: one that reads a local variable or
 * `$this` means something different once evaluated at the call site.
 */
export async function introduceParameter(): Promise<void> {
  const target = activeTarget();

  if (!target) {
    return;
  }

  const scopes = analyzeScopes(target.text);
  const expression = targetExpression(target.text, target.selection, scopes.expressions);
  const scope = expression ? scopeAt(scopes, expression.start, expression.end) : null;

  if (!expression || !scope || scope.kind !== 'method') {
    vscode.window.showWarningMessage('Select an expression inside a method.');
    return;
  }

  const isBound = scope.uses.some((use) => use.start >= expression.start && use.end <= expression.end);

  if (isBound) {
    vscode.window.showWarningMessage('The expression uses local state and cannot become a parameter.');
    return;
  }

  const file = indexedFile(target.document.uri, target.text);
  const method = file.parsed.methods.find((candidate) => candidate.bodyStart === scope.bodyStart);

  if (!method) {
    vscode.window.showWarningMessage('The enclosing method could not be found.');
    return;
  }

  const code = target.text.slice(expression.start, expression.end);
  const name = await askName('Introduce parameter', 'parameter', code.replace(/\s+/g, ' ').slice(0, 80));

  if (!name) {
    return;
  }

  const specs: ParamSpec[] = [
    ...method.params.map((param, index) => ({
      name: param.name,
      type: param.type,
      defaultText: param.defaultText,
      originIndex: index,
      argumentText: null,
    })),
    { name, type: null, defaultText: null, originIndex: null, argumentText: code },
  ];

  // The body edit travels with the signature change so both land in the same undo step,
  // and so no offset is computed on a text that has already moved.
  await applySignature({ file, method }, specs, [
    { file, edit: { start: expression.start, end: expression.end, text: `$${name}` } },
  ]);
}
