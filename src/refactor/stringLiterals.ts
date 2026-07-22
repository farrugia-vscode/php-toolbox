import type { TextEdit } from './editSet';

/**
 * A class name written as a string — a Laravel config, a `dispatch('App\Jobs\Foo')`, a
 * PHPStan annotation — is invisible to the parser but breaks just as loudly when the
 * class moves.
 */
export function stringLiteralEdits(text: string, oldFqn: string, newFqn: string): TextEdit[] {
  const edits: TextEdit[] = [];

  // Double-quoted strings escape the separator, single-quoted ones may or may not.
  const forms: Array<[string, string]> = [
    [oldFqn.replace(/\\/g, '\\\\'), newFqn.replace(/\\/g, '\\\\')],
    [oldFqn, newFqn],
  ];

  for (const [needle, replacement] of forms) {
    let found = text.indexOf(needle);

    while (found !== -1) {
      const before = text[found - 1] ?? '';
      const after = text[found + needle.length] ?? '';

      // A neighbouring word character or separator means this is part of a longer name.
      if (!/[\w\\]/.test(before) && !/[\w\\]/.test(after)) {
        edits.push({ start: found, end: found + needle.length, text: replacement });
      }

      found = text.indexOf(needle, found + needle.length);
    }
  }

  return edits;
}
