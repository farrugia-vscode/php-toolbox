import * as vscode from 'vscode';
import { findDeclaration, indexedFile } from '../php/phpIndex';
import { buildTypeRename, namespaceOf, shortNameOf } from './renameType';

/** The type named at `position`, with the offsets of the short name the user is on. */
function typeAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): { fqn: string; range: vscode.Range } | null {
  const file = indexedFile(document.uri, document.getText());
  const offset = document.offsetAt(position);

  const declaration = file.parsed.declarations.find(
    (candidate) => offset >= candidate.start && offset <= candidate.end,
  );

  if (declaration) {
    return { fqn: declaration.fqn, range: file.mapper.range(declaration.start, declaration.end) };
  }

  const reference = file.parsed.references.find(
    (candidate) => offset >= candidate.start && offset <= candidate.end,
  );

  if (reference) {
    // Rename targets the type, so the edit box shows its short name even when the cursor
    // sits on the namespace part of `Sub\Thing`.
    const written = file.text.slice(reference.start, reference.end);
    const start = reference.start + written.lastIndexOf('\\') + 1;
    return { fqn: reference.fqn, range: file.mapper.range(start, reference.end) };
  }

  const imported = file.parsed.imports.find(
    (candidate) => offset >= candidate.start && offset <= candidate.end,
  );

  if (imported) {
    const start = imported.end - shortNameOf(imported.fqn).length;
    return { fqn: imported.fqn, range: file.mapper.range(start, imported.end) };
  }

  return null;
}

async function applyRename(fqn: string, newName: string): Promise<void> {
  const namespace = namespaceOf(fqn);
  const newFqn = namespace ? `${namespace}\\${newName}` : newName;

  const { edit, manual, referenceCount } = await buildTypeRename(fqn, newFqn);

  if (manual.length > 0) {
    vscode.window.showWarningMessage(
      `Grouped imports left untouched in ${manual.length} file(s): ${manual
        .map((uri) => uri.path.split('/').pop())
        .join(', ')}`,
    );
  }

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(`Renamed to ${newName} — ${referenceCount} edits.`);
}

/**
 * Renaming through a command rather than F2, because the language server also registers a
 * rename provider and there is no way to say which one the editor should ask.
 */
export async function renameType(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const target = typeAt(editor.document, editor.selection.active);

  if (!target || !(await findDeclaration(target.fqn))) {
    vscode.window.showInformationMessage(
      'Place the cursor on a class, interface, trait or enum declared in this project.',
    );
    return;
  }

  const newName = await vscode.window.showInputBox({
    title: `Rename ${target.fqn}`,
    value: shortNameOf(target.fqn),
    validateInput: (value) =>
      /^[A-Za-z_]\w*$/.test(value.trim()) ? null : 'Invalid PHP identifier.',
  });

  if (newName === undefined || newName.trim() === shortNameOf(target.fqn)) {
    return;
  }

  await applyRename(target.fqn, newName.trim());
}

/**
 * Renames a class, interface, trait or enum everywhere, including its file. Handled here
 * rather than left to the language server so it also covers class-strings and works
 * without a paid Intelephense licence.
 */
export class PhpRenameProvider implements vscode.RenameProvider {
  async prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<{ range: vscode.Range; placeholder: string }> {
    const target = typeAt(document, position);

    if (!target) {
      throw new Error('Place the cursor on a class, interface, trait or enum name.');
    }

    if (!(await findDeclaration(target.fqn))) {
      throw new Error(`${target.fqn} is not declared in this project and cannot be renamed.`);
    }

    return { range: target.range, placeholder: shortNameOf(target.fqn) };
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
  ): Promise<vscode.WorkspaceEdit | null> {
    const target = typeAt(document, position);

    if (!target || !/^[A-Za-z_]\w*$/.test(newName)) {
      return null;
    }

    const namespace = namespaceOf(target.fqn);
    const newFqn = namespace ? `${namespace}\\${newName}` : newName;

    if (newFqn === target.fqn) {
      return null;
    }

    const { edit, manual } = await buildTypeRename(target.fqn, newFqn);

    if (manual.length > 0) {
      vscode.window.showWarningMessage(
        `Grouped imports left untouched in ${manual.length} file(s): ${manual
          .map((uri) => uri.path.split('/').pop())
          .join(', ')}`,
      );
    }

    return edit;
  }
}
