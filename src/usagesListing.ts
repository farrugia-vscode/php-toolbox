import type * as vscode from 'vscode';
import { tokenizePhpLine } from './phpTokens';
import type { PreparedEntry, PreparedFile, PreparedGroup, PreparedListing } from './usagesProtocol';
import type { UsageEntry, UsageGroup, UsageListing } from './usagesView';

/** Reads one line of a file, null when the file or the line is gone. */
export type LineReader = (uri: vscode.Uri, line: number) => Promise<string | null>;

/** "1 reference", "8 references": a count reads as a sentence, not as a number. */
export function plural(total: number, word: string): string {
  return `${total} ${total === 1 ? word.replace(/s$/, '') : word}`;
}

/** The relative path split as the panel shows it: the directory greyed out, the file name in front. */
function splitPath(relative: string): { name: string; directory: string } {
  const parts = relative.split('/');

  return { name: parts.pop() ?? relative, directory: parts.join('/') };
}

/**
 * Where the usage sits in the label, once the indentation the label lost is taken off. A
 * label that is not the line it was found on, or a usage spread over lines, gets no mark.
 */
function highlightIn(entry: UsageEntry, line: string | null): [number, number] | null {
  if (line === null || line.trim() !== entry.label || !entry.range.isSingleLine) {
    return null;
  }

  const indentation = line.length - line.trimStart().length;
  const start = entry.range.start.character - indentation;
  const end = entry.range.end.character - indentation;

  if (start < 0 || end > entry.label.length || start >= end) {
    return null;
  }

  return [start, end];
}

async function prepareEntry(entry: UsageEntry, readLine: LineReader): Promise<PreparedEntry> {
  const line = await readLine(entry.uri, entry.range.start.line);
  // A label that differs from its line names something, an implementing class, rather than
  // quoting code; a line that cannot be read is given the benefit of the doubt.
  const isCode = line === null || line.trim() === entry.label;

  return {
    uri: entry.uri.toString(),
    place: {
      line: entry.range.start.line,
      character: entry.range.start.character,
      endLine: entry.range.end.line,
      endCharacter: entry.range.end.character,
    },
    label: entry.label,
    description: entry.description ?? null,
    tokens: isCode ? tokenizePhpLine(entry.label) : null,
    highlight: highlightIn(entry, line),
  };
}

/** The entries of a group, one node per file they sit in, files and lines in reading order. */
async function filesOf(group: UsageGroup, asRelativePath: (uri: vscode.Uri) => string, readLine: LineReader): Promise<PreparedFile[]> {
  const byFile = new Map<string, UsageEntry[]>();

  for (const entry of group.entries) {
    const key = asRelativePath(entry.uri);
    byFile.set(key, [...(byFile.get(key) ?? []), entry]);
  }

  const files: PreparedFile[] = [];

  for (const [relative, entries] of [...byFile.entries()].sort(([first], [second]) => first.localeCompare(second))) {
    const sorted = [...entries].sort((first, second) => first.range.start.compareTo(second.range.start));
    const prepared: PreparedEntry[] = [];

    for (const entry of sorted) {
      prepared.push(await prepareEntry(entry, readLine));
    }

    files.push({ ...splitPath(relative), entries: prepared });
  }

  return files;
}

/** Everything the webview needs to draw the listing, read once here so the panel stays a renderer. */
export async function prepareListing(
  listing: UsageListing,
  asRelativePath: (uri: vscode.Uri) => string,
  readLine: LineReader,
): Promise<PreparedListing> {
  const groups: PreparedGroup[] = [];

  for (const group of listing.groups.filter((candidate) => candidate.entries.length > 0)) {
    groups.push({ label: group.label, total: group.entries.length, files: await filesOf(group, asRelativePath, readLine) });
  }

  const total = groups.reduce((sum, group) => sum + group.total, 0);

  return { subject: listing.subject, subjectTokens: tokenizePhpLine(listing.subject), count: plural(total, listing.unit), groups };
}
