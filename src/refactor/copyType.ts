import type { ParsedFile } from '../php/parser';
import { namespaceOf, shortNameOf } from '../php/fqn';
import { EditSet, type TextEdit } from './editSet';
import { stringLiteralEdits } from './stringLiterals';

/** Rewrites only the trailing segment, leaving whatever prefix was written untouched. */
function replaceLastSegment(written: string, shortNew: string): string {
  const separator = written.lastIndexOf('\\');
  return separator === -1 ? shortNew : `${written.slice(0, separator + 1)}${shortNew}`;
}

/**
 * The edits that turn a declaring file into a copy of itself, under another name, another
 * namespace, or both.
 *
 * Only the copied type is rewritten: its declaration, the namespace line, and the mentions the
 * file makes of it (`new Order`, `Order::class`, `: Order`, a class-string). Every other file is
 * left alone on purpose — a copy adds a type, it never replaces the one it was made from.
 */
export function copyTypeEdits(
  parsed: ParsedFile,
  text: string,
  oldFqn: string,
  newFqn: string,
): TextEdit[] {
  const edits = new EditSet();
  const shortNew = shortNameOf(newFqn);
  const newNamespace = namespaceOf(newFqn);

  parsed.declarations
    .filter((declaration) => declaration.fqn === oldFqn)
    .forEach((declaration) => {
      edits.add({ start: declaration.start, end: declaration.end, text: shortNew });

      if (parsed.namespaceRange && parsed.namespace !== newNamespace) {
        edits.add({
          start: parsed.namespaceRange[0],
          end: parsed.namespaceRange[1],
          text: newNamespace,
        });
      }
    });

  parsed.references
    .filter((reference) => reference.fqn === oldFqn)
    .forEach((reference) => {
      const written = text.slice(reference.start, reference.end);

      edits.add({
        start: reference.start,
        end: reference.end,
        text:
          reference.resolution === 'fqn'
            ? `\\${newFqn}`
            : replaceLastSegment(written, shortNew),
      });
    });

  stringLiteralEdits(text, oldFqn, newFqn).forEach((edit) => edits.add(edit));

  return edits.all();
}
