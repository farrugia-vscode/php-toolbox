import * as vscode from 'vscode';
import { getPhpIndex, type IndexedFile } from '../php/phpIndex';
import { directoryForNamespace } from '../php/psr4';
import { namespaceOf, shortNameOf } from '../php/fqn';
import { stringLiteralEdits } from './stringLiterals';
import { EditSet, type TextEdit } from './editSet';

export interface TypeRename {
  edit: vscode.WorkspaceEdit;
  /** Files a grouped import made impossible to rewrite safely. */
  manual: vscode.Uri[];
  referenceCount: number;
}

export { namespaceOf, shortNameOf } from '../php/fqn';

/** Rewrites only the trailing segment, leaving whatever prefix was written untouched. */
function replaceLastSegment(written: string, shortNew: string): string {
  const separator = written.lastIndexOf('\\');
  return separator === -1 ? shortNew : `${written.slice(0, separator + 1)}${shortNew}`;
}

function importEdit(
  target: { fqn: string; groupPrefix: string; start: number; end: number },
  newFqn: string,
): TextEdit | 'manual' {
  if (!target.groupPrefix) {
    return { start: target.start, end: target.end, text: newFqn };
  }

  const prefix = `${target.groupPrefix}\\`;

  // The item only stays valid inside its group while it keeps the shared prefix.
  if (!newFqn.startsWith(prefix)) {
    return 'manual';
  }

  return { start: target.start, end: target.end, text: newFqn.slice(prefix.length) };
}

/**
 * Rewrites every mention of a type across the workspace, whether it goes through an
 * import, the current namespace, a fully qualified name or a class-string.
 */
function collectFileEdits(
  file: IndexedFile,
  oldFqn: string,
  newFqn: string,
  manual: vscode.Uri[],
): EditSet {
  const edits = new EditSet();
  const shortNew = shortNameOf(newFqn);
  const shortOld = shortNameOf(oldFqn);
  const newNamespace = namespaceOf(newFqn);
  const { parsed, text } = file;

  parsed.declarations
    .filter((declaration) => declaration.fqn === oldFqn)
    .forEach((declaration) => {
      edits.add({ start: declaration.start, end: declaration.end, text: shortNew });

      if (parsed.namespaceRange && parsed.namespace !== newNamespace) {
        edits.add({ start: parsed.namespaceRange[0], end: parsed.namespaceRange[1], text: newNamespace });
      }
    });

  const imports = parsed.imports.filter((entry) => entry.fqn === oldFqn);

  imports.forEach((entry) => {
    const edit = importEdit(entry, newFqn);

    if (edit === 'manual') {
      manual.push(file.uri);
      return;
    }

    edits.add(edit);
  });

  const aliases = new Set(imports.map((entry) => entry.alias.toLowerCase()));
  let needsImport = false;

  parsed.references
    .filter((reference) => reference.fqn === oldFqn)
    .forEach((reference) => {
      const written = text.slice(reference.start, reference.end);

      if (reference.resolution === 'fqn') {
        edits.add({ start: reference.start, end: reference.end, text: `\\${newFqn}` });
        return;
      }

      const firstSegment = written.replace(/^\\/, '').split('\\')[0];

      if (aliases.has(firstSegment.toLowerCase())) {
        // A custom alias (`use X as Y`) keeps its own name; the import line carries the change.
        if (firstSegment.toLowerCase() === shortOld.toLowerCase()) {
          edits.add({ start: reference.start, end: reference.end, text: replaceLastSegment(written, shortNew) });
        }
        return;
      }

      // Resolved through the current namespace: it only keeps working if the type stays in it.
      if (parsed.namespace === newNamespace) {
        edits.add({ start: reference.start, end: reference.end, text: replaceLastSegment(written, shortNew) });
        return;
      }

      edits.add({ start: reference.start, end: reference.end, text: shortNew });
      needsImport = true;
    });

  if (needsImport && imports.length === 0) {
    edits.add({ start: parsed.importAnchor, end: parsed.importAnchor, text: `use ${newFqn};\n` });
  }

  stringLiteralEdits(text, oldFqn, newFqn).forEach((edit) => edits.add(edit));

  return edits;
}

/** Where the declaring file must end up once the class carries a new name or namespace. */
async function targetUri(file: IndexedFile, oldFqn: string, newFqn: string): Promise<vscode.Uri | null> {
  const basename = file.uri.path.split('/').pop() ?? '';

  // Only rename files named after the class: a file holding several types is not ours to move.
  if (basename !== `${shortNameOf(oldFqn)}.php` || file.parsed.declarations.length !== 1) {
    return null;
  }

  const directory = await directoryForNamespace(namespaceOf(newFqn));
  const parent = directory ?? vscode.Uri.joinPath(file.uri, '..');
  const target = vscode.Uri.joinPath(parent, `${shortNameOf(newFqn)}.php`);

  return target.toString() === file.uri.toString() ? null : target;
}

/**
 * Every edit needed to turn `oldFqn` into `newFqn`, ready for the refactor preview.
 *
 * `moveFile` is off when the editor is already moving the file itself, which is the case
 * for a drag and drop in the explorer.
 */
export async function buildTypeRename(
  oldFqn: string,
  newFqn: string,
  { moveFile = true }: { moveFile?: boolean } = {},
): Promise<TypeRename> {
  const edit = new vscode.WorkspaceEdit();
  const manual: vscode.Uri[] = [];
  let referenceCount = 0;
  let declaringFile: IndexedFile | null = null;

  for (const file of await getPhpIndex()) {
    if (!file.text.includes(shortNameOf(oldFqn))) {
      continue;
    }

    const fileEdits = collectFileEdits(file, oldFqn, newFqn, manual);

    fileEdits.all().forEach((textEdit) => {
      referenceCount++;
      edit.replace(file.uri, file.mapper.range(textEdit.start, textEdit.end), textEdit.text);
    });

    if (file.parsed.declarations.some((declaration) => declaration.fqn === oldFqn)) {
      declaringFile = file;
    }
  }

  if (declaringFile && moveFile) {
    const target = await targetUri(declaringFile, oldFqn, newFqn);

    if (target) {
      edit.renameFile(declaringFile.uri, target, { overwrite: false });
    }
  }

  return { edit, manual, referenceCount };
}
