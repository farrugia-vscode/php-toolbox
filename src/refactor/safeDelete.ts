import * as vscode from 'vscode';
import { getPhpIndex, indexedFile, type IndexedFile } from '../php/phpIndex';
import type { Span } from '../php/scopes';
import { confirm } from './apply';
import { classAt } from './classEdits';
import { findMemberSites } from './callSites';
import { memberAtCursor } from './renameMember';
import { afterLine, blankLineBefore, docblockStart, lineStartOf } from './textLayout';

/** What is about to be deleted, and everything that still points at it. */
interface Deletion {
  label: string;
  span: Span | null;
  file: IndexedFile;
  /** Set when the whole file goes: it declares nothing else. */
  isWholeFile: boolean;
  usages: Array<{ uri: vscode.Uri; range: vscode.Range; line: string }>;
}

function spanOf(file: IndexedFile, start: number, end: number): Span {
  return {
    start: blankLineBefore(file.text, lineStartOf(file.text, docblockStart(file.text, start))),
    end: afterLine(file.text, end),
  };
}

/** The member the cursor is on, with every mention of it outside its own declaration. */
async function memberDeletion(file: IndexedFile, offset: number): Promise<Deletion | null> {
  const target = await memberAtCursor(file, offset);

  if (!target) {
    return null;
  }

  const declared =
    target.kind === 'method'
      ? file.parsed.methods.find((method) => method.className === target.className && method.name === target.name)
      : target.kind === 'constant'
        ? file.parsed.constants.find((constant) => constant.className === target.className && constant.name === target.name)
        : file.parsed.properties.find((property) => property.className === target.className && property.name === target.name);

  if (!declared) {
    return null;
  }

  const span = spanOf(file, declared.start, declared.end);
  const { sites } = await findMemberSites(target);

  return {
    label: `${target.className.split('\\').pop()}::${target.name}`,
    span,
    file,
    isWholeFile: false,
    usages: sites
      .filter((site) => site.file.uri.toString() !== file.uri.toString() || site.nameStart < span.start || site.nameStart > span.end)
      .map((site) => ({
        uri: site.file.uri,
        range: site.file.mapper.range(site.nameStart, site.nameEnd),
        line: lineOf(site.file.text, site.nameStart),
      })),
  };
}

/** The type declared in the file, with every file naming it. */
async function typeDeletion(file: IndexedFile, offset: number): Promise<Deletion | null> {
  const declaration = classAt(file.parsed, offset) ?? file.parsed.declarations.find(
    (candidate) => offset >= candidate.start && offset <= candidate.end,
  );

  if (!declaration) {
    return null;
  }

  const usages = (await getPhpIndex()).flatMap((candidate) =>
    candidate.parsed.references
      .filter((reference) => reference.fqn === declaration.fqn && candidate.uri.toString() !== file.uri.toString())
      .map((reference) => ({
        uri: candidate.uri,
        range: candidate.mapper.range(reference.start, reference.end),
        line: lineOf(candidate.text, reference.start),
      })),
  );

  return {
    label: declaration.fqn,
    span: file.parsed.declarations.length === 1 ? null : spanOf(file, declaration.start, declaration.bodyEnd + 1),
    file,
    isWholeFile: file.parsed.declarations.length === 1,
    usages,
  };
}

function lineOf(text: string, offset: number): string {
  return text.slice(lineStartOf(text, offset), afterLine(text, offset)).trim();
}

/** Lets the user look at what still uses the code before deciding to remove it. */
async function reviewUsages(deletion: Deletion): Promise<boolean> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(trash) Delete anyway', isDeleting: true, description: `${deletion.usages.length} usage(s) will break` },
      ...deletion.usages.map((usage) => ({
        label: `$(go-to-file) ${usage.uri.path.split('/').pop()}:${usage.range.start.line + 1}`,
        description: usage.line,
        isDeleting: false,
        usage,
      })),
    ],
    { title: `${deletion.label} is still used ${deletion.usages.length} time(s)` },
  );

  if (!picked) {
    return false;
  }

  if (!picked.isDeleting) {
    const usage = (picked as { usage?: { uri: vscode.Uri; range: vscode.Range } }).usage;

    if (usage) {
      const document = await vscode.workspace.openTextDocument(usage.uri);
      const opened = await vscode.window.showTextDocument(document);
      opened.selection = new vscode.Selection(usage.range.start, usage.range.end);
      opened.revealRange(usage.range, vscode.TextEditorRevealType.InCenter);
    }

    return false;
  }

  return true;
}

/**
 * Removes a member or a type, but only after showing what still uses it.
 *
 * Deleting code that nothing calls is the ordinary case and goes through in one step; the
 * moment something does call it, the list comes first.
 */
export async function safeDelete(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const offset = editor.document.offsetAt(editor.selection.active);
  const deletion = (await memberDeletion(file, offset)) ?? (await typeDeletion(file, offset));

  if (!deletion) {
    vscode.window.showWarningMessage('Place the cursor on a member or on a type declaration.');
    return;
  }

  if (deletion.usages.length > 0 && !(await reviewUsages(deletion))) {
    return;
  }

  if (deletion.isWholeFile && !(await confirm(`Delete ${file.uri.path.split('/').pop()}?`))) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();

  if (deletion.isWholeFile) {
    edit.deleteFile(file.uri, { ignoreIfNotExists: true });
  } else if (deletion.span) {
    edit.replace(file.uri, file.mapper.range(deletion.span.start, deletion.span.end), '');
  }

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(`${deletion.label} deleted.`);
}
