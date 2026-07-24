import * as vscode from 'vscode';
import { shortNameOf } from '../php/fqn';
import type { Declaration } from '../php/parser';
import { getPhpIndex, indexedFile, type IndexedFile } from '../php/phpIndex';
import { analyzeScopes, scopeAt } from '../php/scopes';
import { askName, withProgress } from './apply';
import { classAt, memberIndent, memberInsertOffset, memberText } from './classEdits';
import { EditSet } from './editSet';
import { sameOccurrences, suggestName, targetExpression } from './extractExpression';
import { importEdit } from './imports';

interface Host {
  file: IndexedFile;
  declaration: Declaration;
}

/** Types the constant could live in, the ones already holding constants first. */
async function hosts(): Promise<Host[]> {
  const files = await getPhpIndex();

  return files
    .flatMap((file) => file.parsed.declarations.map((declaration) => ({ file, declaration })))
    .sort((first, second) => {
      const count = (host: Host): number =>
        host.file.parsed.constants.filter((constant) => constant.className === host.declaration.fqn).length;

      return count(second) - count(first) || first.declaration.name.localeCompare(second.declaration.name);
    });
}

/**
 * Extracts a literal into a constant of another class, and points every occurrence at it.
 *
 * Values shared across classes belong somewhere both sides can name, and moving them there
 * by hand means writing the constant, the import and each `Class::NAME` one at a time.
 */
export async function extractConstantToClass(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const source = indexedFile(editor.document.uri, editor.document.getText());
  const selection = {
    start: editor.document.offsetAt(editor.selection.start),
    end: editor.document.offsetAt(editor.selection.end),
  };
  const scopes = analyzeScopes(source.text);
  const expression = targetExpression(source.text, selection, scopes.expressions);

  if (!expression || !expression.isConstant) {
    vscode.window.showWarningMessage('Select an expression made of literals.');
    return;
  }

  const candidates = await withProgress('Reading the classes of the project…', hosts);
  const picked = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: `$(symbol-class) ${candidate.declaration.name}`,
      description: candidate.declaration.fqn,
      detail: vscode.workspace.asRelativePath(candidate.file.uri),
      candidate,
    })),
    { title: 'Class the constant belongs to', matchOnDescription: true, matchOnDetail: true },
  );

  if (!picked) {
    return;
  }

  const host = picked.candidate;
  const code = source.text.slice(expression.start, expression.end);
  const taken = host.file.parsed.constants
    .filter((constant) => constant.className === host.declaration.fqn)
    .map((constant) => constant.name);
  const name = await askName(
    `Extract constant to ${host.declaration.name}`,
    suggestName(code, 'constant'),
    code.replace(/\s+/g, ' ').slice(0, 80),
    taken,
  );

  if (!name) {
    return;
  }

  const isSameClass = classAt(source.parsed, expression.start)?.fqn === host.declaration.fqn;
  const reference = isSameClass ? `self::${name}` : `${host.declaration.name}::${name}`;
  const scope = scopeAt(scopes, expression.start, expression.end);
  const bounds = scope
    ? { start: scope.bodyStart, end: scope.bodyEnd }
    : { start: 0, end: source.text.length };
  const occurrences = sameOccurrences(source.text, scopes.expressions, expression, bounds);

  // The constant may well land in the file it came from, so both sides share one edit set.
  const byFile = new Map<string, { file: IndexedFile; edits: EditSet }>();
  const add = (file: IndexedFile, textEdit: { start: number; end: number; text: string }): void => {
    const entry = byFile.get(file.uri.toString()) ?? { file, edits: new EditSet() };
    entry.edits.add(textEdit);
    byFile.set(file.uri.toString(), entry);
  };

  occurrences.forEach((occurrence) =>
    add(source, { start: occurrence.start, end: occurrence.end, text: reference }),
  );

  // A constant read from another class is part of its API, and the file has to name it.
  if (!isSameClass) {
    const imports = importEdit(source.parsed, [host.declaration.fqn]);

    if (imports) {
      add(source, imports);
    }
  }

  const anchor = memberInsertOffset(host.file.text, host.file.parsed, host.declaration, 'constant');

  add(host.file, {
    start: anchor.offset,
    end: anchor.offset,
    text: memberText(
      `${isSameClass ? 'private' : 'public'} const ${name} = ${code};`,
      memberIndent(host.file.text, host.file.parsed, host.declaration),
      anchor,
    ),
  });

  const edit = new vscode.WorkspaceEdit();

  byFile.forEach(({ file, edits }) => {
    edits.all().forEach((textEdit) => {
      edit.replace(file.uri, file.mapper.range(textEdit.start, textEdit.end), textEdit.text);
    });
  });

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(
    `${shortNameOf(host.declaration.fqn)}::${name} — ${occurrences.length} occurrence(s) replaced.`,
  );
}
