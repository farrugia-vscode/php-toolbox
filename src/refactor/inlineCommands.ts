import * as vscode from 'vscode';
import { analyzeScopes } from '../php/scopes';
import { indexedFile, type IndexedFile } from '../php/phpIndex';
import { activeTarget, applyPlan, confirm, withProgress } from './apply';
import { findCallSites, methodAtCursor, type CallSite } from './callSites';
import { EditSet } from './editSet';
import { inlineCall, inlineTarget, removeMethod, type InlineTarget } from './inlineMethod';
import { planInlineVariable } from './inlineVariable';

export async function inlineVariable(): Promise<void> {
  const target = activeTarget();

  if (!target) {
    return;
  }

  await applyPlan(target.document, planInlineVariable(target.text, target.selection.start));
}

/** Edits for every call in one file, and the calls that had to be left alone. */
function inlineInFile(file: IndexedFile, sites: CallSite[], target: InlineTarget): { edits: EditSet; refusals: string[] } {
  const scopes = analyzeScopes(file.text);
  const edits = new EditSet();
  const refusals: string[] = [];

  sites.forEach((site) => {
    const result = inlineCall(file.text, scopes, site.call, target);

    if ('error' in result) {
      refusals.push(result.error);
      return;
    }

    edits.add(result);
  });

  return { edits, refusals };
}

function groupByFile(sites: CallSite[]): Map<IndexedFile, CallSite[]> {
  const grouped = new Map<IndexedFile, CallSite[]>();

  sites.forEach((site) => grouped.set(site.file, [...(grouped.get(site.file) ?? []), site]));

  return grouped;
}

/**
 * Replaces every call to a method by its body and removes the method.
 *
 * The method is only removed when every call could be rewritten: a half-inlined method that
 * disappears leaves the project broken.
 */
export async function inlineMethod(): Promise<void> {
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

  const { method } = location;
  const owner = location.file.parsed.declarations.find((declaration) => declaration.fqn === method.className);
  const isFinalClass = owner ? /\bfinal\s+class\b/.test(location.file.text.slice(Math.max(owner.start - 30, 0), owner.start)) : false;
  const target = inlineTarget(location.file.text, method, isFinalClass);

  if ('error' in target) {
    vscode.window.showWarningMessage(target.error);
    return;
  }

  const { sites, isNameShared } = await withProgress(`Looking for calls to ${method.name}()…`, () =>
    findCallSites(method),
  );
  const uncertain = sites.filter((site) => !site.isCertain);

  if (uncertain.length > 0 && isNameShared) {
    const isConfirmed = await confirm(
      `${uncertain.length} call(s) to ${method.name}() are made on a variable, and another class declares a method with that name. Inline them anyway?`,
    );

    if (!isConfirmed) {
      return;
    }
  }

  const refusals: string[] = [];
  const byFile = new Map<IndexedFile, EditSet>();

  for (const [host, hostSites] of groupByFile(sites)) {
    const result = inlineInFile(host, hostSites, target);
    refusals.push(...result.refusals);
    byFile.set(host, result.edits);
  }

  if (refusals.length > 0) {
    const isConfirmed = await confirm(
      `${refusals.length} call(s) cannot be inlined — ${[...new Set(refusals)].join('; ')}. Inline the others and keep the method?`,
    );

    if (!isConfirmed) {
      return;
    }
  }

  if (refusals.length === 0) {
    const source = [...byFile.keys()].find((host) => host.uri.toString() === location.file.uri.toString());
    const edits = source ? byFile.get(source)! : new EditSet();

    edits.add(removeMethod(location.file.text, method));
    byFile.set(source ?? location.file, edits);
  }

  const edit = new vscode.WorkspaceEdit();
  let touched = 0;

  byFile.forEach((edits, host) => {
    const all = edits.all();

    if (all.length > 0) {
      touched++;
    }

    all.forEach((textEdit) => {
      edit.replace(host.uri, host.mapper.range(textEdit.start, textEdit.end), textEdit.text);
    });
  });

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(
    `Inlined ${method.name}() into ${sites.length - refusals.length} call(s) across ${touched} file(s).`,
  );
}
