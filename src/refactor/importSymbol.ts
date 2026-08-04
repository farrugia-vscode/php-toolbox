import * as vscode from 'vscode';
import { getPhpIndex, indexedFile, type IndexedFile } from '../php/phpIndex';
import { importEdit } from './imports';
import type { TextEdit } from './editSet';

/** A type the file names but cannot reach, and where its short name was written. */
export interface UnresolvedType {
  shortName: string;
  start: number;
  end: number;
}

/**
 * The name under the cursor, when nothing in the project answers to it as written. The
 * parser resolves a bare name against the current namespace, so an unimported class comes
 * back as a type that simply does not exist.
 */
export function unresolvedTypeAt(
  file: IndexedFile,
  offset: number,
  declared: Set<string>,
): UnresolvedType | null {
  const reference = file.parsed.references.find(
    (candidate) => candidate.start <= offset && candidate.end >= offset,
  );

  if (!reference || reference.resolution === 'fqn' || declared.has(reference.fqn)) {
    return null;
  }

  const shortName = reference.fqn.split('\\').pop() as string;

  // A name already imported resolves; so does one declared in the file itself.
  const isImported = file.parsed.imports.some((entry) => entry.fqn === reference.fqn);
  const isLocal = file.parsed.declarations.some((entry) => entry.fqn === reference.fqn);

  return isImported || isLocal ? null : { shortName, start: reference.start, end: reference.end };
}

/** Every project type that could be what the short name meant. */
export function candidatesFor(files: IndexedFile[], shortName: string): string[] {
  const found = files.flatMap((file) =>
    file.parsed.declarations
      .filter((declaration) => declaration.name === shortName)
      .map((declaration) => declaration.fqn),
  );

  return [...new Set(found)].sort();
}

/** The `use` line to add for the chosen type. */
export function importEditFor(file: IndexedFile, fqn: string): TextEdit | null {
  return importEdit(file.parsed, [fqn]);
}

/**
 * Offers the missing `use` for a type the file names without importing it, one action per
 * candidate so a short name shared by several namespaces stays a choice.
 */
export class ImportCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    _context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeAction[]> {
    const file = indexedFile(document.uri, document.getText());
    const declared = new Set(file.parsed.declarations.map((declaration) => declaration.fqn));
    const unresolved = unresolvedTypeAt(file, document.offsetAt(range.start), declared);

    if (!unresolved) {
      return [];
    }

    const index = await getPhpIndex();

    if (token.isCancellationRequested) {
      return [];
    }

    return candidatesFor(index, unresolved.shortName).map((fqn) => {
      const action = new vscode.CodeAction(`Import ${fqn}`, vscode.CodeActionKind.QuickFix);
      const edit = importEditFor(file, fqn);

      if (edit) {
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(
          document.uri,
          new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
          edit.text,
        );
      }

      return action;
    });
  }
}
