/** A package a composer.json requires, with where its name and its constraint sit in the text. */
export type PackageMention = {
  name: string;
  nameStart: number;
  nameEnd: number;
  constraintStart: number;
  constraintEnd: number;
};

const SECTIONS = ['require', 'require-dev'];

/** The braces of one `"require": { ... }` block, which composer keeps flat: the first `}` closes it. */
function sectionSpan(text: string, section: string): { start: number; end: number } | null {
  const opening = new RegExp(`"${section}"\\s*:\\s*\\{`).exec(text);

  if (!opening) {
    return null;
  }

  const start = opening.index + opening[0].length;
  const end = text.indexOf('}', start);

  return end === -1 ? null : { start, end };
}

/**
 * Every `"vendor/name": "^1.2"` of the require sections, in the order written. `php` and
 * `ext-json` are requirements too but name no package, so they are left out.
 */
export function packageMentions(text: string): PackageMention[] {
  const mentions: PackageMention[] = [];

  for (const section of SECTIONS) {
    const span = sectionSpan(text, section);

    if (!span) {
      continue;
    }

    const entries = /"([a-z0-9_.-]+\/[a-z0-9_.-]+)"\s*:\s*"([^"]*)"/gi;
    entries.lastIndex = span.start;

    for (const match of text.slice(0, span.end).matchAll(entries)) {
      const [whole, name, constraint] = match;
      const nameStart = (match.index ?? 0) + 1;
      const constraintEnd = (match.index ?? 0) + whole.length - 1;

      mentions.push({ name, nameStart, nameEnd: nameStart + name.length, constraintStart: constraintEnd - constraint.length, constraintEnd });
    }
  }

  return mentions;
}
