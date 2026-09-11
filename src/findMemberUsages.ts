import * as vscode from 'vscode';
import { memberAliases } from './api';
import type { AccessMode } from './php/members';
import { findMemberSites, type MemberSearch, type MemberSite } from './refactor/callSites';
import { indexedFile } from './php/phpIndex';
import { memberAtCursor, type MemberTarget } from './refactor/renameMember';
import { showUsagesView, type UsageEntry, type UsageGroup } from './usagesView';

/** The line a mention sits on, trimmed: enough to recognise the call without opening it. */
function lineAt(site: MemberSite): string {
  const start = site.file.text.lastIndexOf('\n', site.nameStart) + 1;
  const end = site.file.text.indexOf('\n', site.nameEnd);

  return site.file.text.slice(start, end === -1 ? undefined : end).trim();
}

/**
 * The three questions asked of a property, in the order they are asked. A method served as
 * a property is still callable, so its calls come last, under a heading of their own.
 */
const ACCESS_LABELS: Array<{ access: AccessMode | undefined; label: string }> = [
  { access: 'write', label: 'written' },
  { access: 'readwrite', label: 'read and written' },
  { access: 'read', label: 'read' },
  { access: undefined, label: 'called' },
];

function entryOf(site: MemberSite): UsageEntry {
  return { uri: site.file.uri, range: site.file.mapper.range(site.nameStart, site.nameEnd), label: lineAt(site) };
}

function groupByAccess(search: MemberSearch): UsageGroup[] {
  const group = (label: string, sites: MemberSite[]): UsageGroup => ({ label, entries: sites.map(entryOf) });

  const sites = [...search.sites, ...search.arguments];
  // A method is called and nothing else: splitting its sites would only add an empty heading.
  const found = sites.every((site) => site.access === undefined)
    ? [group('usages', sites)]
    : ACCESS_LABELS.map(({ access, label }) =>
        group(
          label,
          sites.filter((site) => site.access === access),
        ),
      );

  return [
    ...found,
    // Mentions of the name whose receiver nothing declared a type for. They may or may not
    // be this member, so no refactoring touches them — but hiding them would hide the one
    // place where a rename can leave the project broken.
    group('receiver type unknown', search.unresolved),
  ];
}

/** The member with the names a framework reaches it by, read from the return type it declares. */
function withAliases(target: MemberTarget): MemberTarget {
  const declared = target.file.parsed.methods.find(
    (method) => method.className === target.className && method.name === target.name,
  );

  return {
    ...target,
    aliases: memberAliases({
      kind: target.kind,
      name: target.name,
      className: target.className,
      returnType: target.kind === 'method' ? (declared?.returnType ?? null) : null,
    }),
  };
}

/** What to call the thing being searched, in the progress message and the picker. */
function labelOf(target: MemberTarget): string {
  const kind = target.kind === 'method' ? '' : target.kind === 'constant' ? '::' : '->';

  return `${target.className.split('\\').pop()}${kind === '' ? '::' : kind}${target.name}${target.kind === 'method' ? '()' : ''}`;
}

/**
 * Lists what calls a method or reads a property, anywhere in the project. `Find usages` on
 * a type answers with types; this one answers with call sites, which is what a public
 * member is asked about.
 */
export async function showMemberUsages(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const target = await memberAtCursor(file, editor.document.offsetAt(editor.selection.active));

  if (!target) {
    vscode.window.showInformationMessage('Put the cursor on a method, a property or a constant.');
    return;
  }

  const name = labelOf(target);
  const search = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Searching usages of ${name}…` },
    () => findMemberSites(withAliases(target)),
  );

  if (search.sites.length + search.arguments.length + search.unresolved.length === 0) {
    vscode.window.showInformationMessage(`No usages found for ${name}.`);
    return;
  }

  await showUsagesView({ subject: name, unit: 'usages', groups: groupByAccess(search) });
}
