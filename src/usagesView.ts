import * as vscode from 'vscode';

const VIEW_ID = 'phpToolbox.usages';
const HAS_LISTING_CONTEXT = 'phpToolbox.usages.hasListing';
const MAX_LABEL = 100;

/** One place in the project, as a line of the listing. */
export interface UsageEntry {
  uri: vscode.Uri;
  range: vscode.Range;
  /** What the line reads as: the code itself, or the name of the class found there. */
  label: string;
  description?: string;
}

/** Entries put under one heading, by what the code does with the symbol. */
export interface UsageGroup {
  label: string;
  entries: UsageEntry[];
}

/** What a search answers: the symbol asked about, and its usages sorted by intent. */
export interface UsageListing {
  subject: string;
  /** How the entries are counted in the heading: "references", "usages", "implementations". */
  unit: string;
  groups: UsageGroup[];
}

/** "1 reference", "8 references": a count reads as a sentence, not as a number. */
export function plural(total: number, word: string): string {
  return `${total} ${total === 1 ? word.replace(/s$/, '') : word}`;
}

interface GroupNode {
  kind: 'group';
  id: string;
  label: string;
  total: number;
  files: FileNode[];
}

interface FileNode {
  kind: 'file';
  id: string;
  uri: vscode.Uri;
  entries: EntryNode[];
}

interface EntryNode {
  kind: 'entry';
  id: string;
  entry: UsageEntry;
}

type UsageNode = GroupNode | FileNode | EntryNode;

/** The entries of a group, one node per file they sit in, files and lines in reading order. */
function filesOf(group: UsageGroup, groupId: string): FileNode[] {
  const byFile = new Map<string, UsageEntry[]>();

  for (const entry of group.entries) {
    const key = entry.uri.toString();
    byFile.set(key, [...(byFile.get(key) ?? []), entry]);
  }

  return [...byFile.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([, entries], fileIndex) => ({
      kind: 'file' as const,
      id: `${groupId}/${fileIndex}`,
      uri: entries[0].uri,
      entries: entries
        .sort((first, second) => first.range.start.compareTo(second.range.start))
        .map((entry, entryIndex) => ({
          kind: 'entry' as const,
          id: `${groupId}/${fileIndex}/${entryIndex}`,
          entry,
        })),
    }));
}

/**
 * The tree behind the panel: heading, then file, then line, every level open by default.
 *
 * Each search numbers its nodes afresh: the editor remembers what was folded by node id,
 * so reusing ids would open a new listing with the folds of the previous one.
 */
class UsagesTreeProvider implements vscode.TreeDataProvider<UsageNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private groups: GroupNode[] = [];
  private listings = 0;

  replace(listing: UsageListing): void {
    this.listings += 1;
    this.groups = listing.groups
      .filter((group) => group.entries.length > 0)
      .map((group, index) => {
        const id = `${this.listings}/${index}`;

        return { kind: 'group' as const, id, label: group.label, total: group.entries.length, files: filesOf(group, id) };
      });
    this.changed.fire();
  }

  getChildren(node?: UsageNode): UsageNode[] {
    if (node === undefined) {
      return this.groups;
    }

    if (node.kind === 'group') {
      return node.files;
    }

    if (node.kind === 'file') {
      return node.entries;
    }

    return [];
  }

  getTreeItem(node: UsageNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.description = String(node.total);
      item.iconPath = new vscode.ThemeIcon('references');

      return item;
    }

    if (node.kind === 'file') {
      const relative = vscode.workspace.asRelativePath(node.uri);
      const item = new vscode.TreeItem(relative.split('/').pop() ?? relative, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.description = relative.split('/').slice(0, -1).join('/');
      item.resourceUri = node.uri;
      item.iconPath = vscode.ThemeIcon.File;

      return item;
    }

    const { entry } = node;
    const label = entry.label.length > MAX_LABEL ? `${entry.label.slice(0, MAX_LABEL)}…` : entry.label;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = entry.description ?? `line ${entry.range.start.line + 1}`;
    item.tooltip = entry.label;
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [entry.uri, { selection: entry.range }],
    };

    return item;
  }
}

const provider = new UsagesTreeProvider();
let view: vscode.TreeView<UsageNode> | null = null;

export function registerUsagesView(): vscode.Disposable {
  view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });

  return view;
}

/**
 * Puts a listing in the panel and brings the panel up.
 *
 * A quick pick shows one flat column where a heading is a thin grey line; the panel gives
 * every heading and every file a fold of its own, which is what a long listing needs to be
 * read rather than scrolled.
 */
export async function showUsagesView(listing: UsageListing): Promise<void> {
  const total = listing.groups.reduce((sum, group) => sum + group.entries.length, 0);

  provider.replace(listing);

  if (view) {
    view.description = `${listing.subject}: ${plural(total, listing.unit)}`;
  }

  await vscode.commands.executeCommand('setContext', HAS_LISTING_CONTEXT, true);
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}
