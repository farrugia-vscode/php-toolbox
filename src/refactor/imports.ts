import type { ParsedFile } from '../php/parser';
import type { Span } from '../php/scopes';
import type { IndexedFile } from '../php/phpIndex';
import type { TextEdit } from './editSet';
import { namespaceOf } from '../php/fqn';

/** Types a slice of code names, as fully qualified names. */
export function typesUsedIn(file: IndexedFile, span: Span): string[] {
  return [
    ...new Set(
      file.parsed.references
        .filter((reference) => reference.start >= span.start && reference.end <= span.end)
        .map((reference) => reference.fqn),
    ),
  ];
}

/**
 * The single import line a file needs to keep naming those types, or null when it already
 * has them — moved code keeps compiling only if its imports travel with it.
 */
export function importEdit(parsed: ParsedFile, types: string[]): TextEdit | null {
  const known = new Set(parsed.imports.map((entry) => entry.fqn));
  const missing = types.filter(
    (fqn) => fqn.includes('\\') && !known.has(fqn) && namespaceOf(fqn) !== parsed.namespace,
  );

  if (missing.length === 0) {
    return null;
  }

  return {
    start: parsed.importAnchor,
    end: parsed.importAnchor,
    text: missing.map((fqn) => `use ${fqn};\n`).join(''),
  };
}
