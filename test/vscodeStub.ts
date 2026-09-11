/**
 * The parts of the VS Code API the refactoring code touches. Enough to exercise the
 * rename engine outside an extension host, where a real API is not available.
 */
export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}

  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }

  compareTo(other: Position): number {
    return this.line - other.line || this.character - other.character;
  }
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class Uri {
  readonly scheme = 'file';

  private constructor(public readonly path: string) {}

  static file(path: string): Uri {
    return new Uri(path);
  }

  static parse(value: string): Uri {
    return new Uri(value.replace(/^file:\/\//, ''));
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri([base.path.replace(/\/$/, ''), ...segments].join('/'));
  }

  toString(): string {
    return `file://${this.path}`;
  }
}

export interface StubTextEdit {
  range: Range;
  newText: string;
}

export class WorkspaceEdit {
  private readonly byFile = new Map<string, StubTextEdit[]>();
  readonly renames: Array<{ from: string; to: string }> = [];

  replace(uri: Uri, range: Range, newText: string): void {
    const key = uri.toString();
    this.byFile.set(key, [...(this.byFile.get(key) ?? []), { range, newText }]);
  }

  renameFile(from: Uri, to: Uri): void {
    this.renames.push({ from: from.toString(), to: to.toString() });
  }

  entries(): Array<[Uri, StubTextEdit[]]> {
    return [...this.byFile].map(([key, edits]) => [Uri.parse(key), edits]);
  }
}

export class EventEmitter<T> {
  event = (_listener: (value: T) => void): void => {};
  fire(_value: T): void {}
}

export class Disposable {
  constructor(private readonly onDispose: () => void) {}

  dispose(): void {
    this.onDispose();
  }
}

export const workspace = {
  textDocuments: [] as Array<{ isDirty: boolean; uri: Uri; getText(): string }>,
  onDidChangeTextDocument: (): { dispose(): void } => ({ dispose: () => {} }),
  asRelativePath: (uri: Uri | string): string => (typeof uri === 'string' ? uri : uri.path).replace(/^\/p\//, ''),
};

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  resourceUri?: Uri;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };

  constructor(
    public readonly label: string,
    public readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');

  constructor(public readonly id: string) {}
}

/** What the last `createTreeView` was given, so a test can drive the provider by hand. */
export const createdTreeViews: Array<{ id: string; treeDataProvider: any; description?: string }> = [];

/** Commands run through the stub, in order. */
export const executedCommands: Array<{ command: string; arguments: unknown[] }> = [];

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]): Promise<void> => {
    executedCommands.push({ command, arguments: args });
  },
};

/** Only the kinds the extension names; the numbers match the real API. */
export const SymbolKind = {
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constant: 13,
  Interface: 10,
  Struct: 22,
  Enum: 9,
  EnumMember: 21,
};

export const window = {
  showWarningMessage: (message: string): void => console.warn(message),
  createTreeView: (id: string, options: { treeDataProvider: any }): { id: string; treeDataProvider: any; description?: string; dispose(): void } => {
    const view = { id, treeDataProvider: options.treeDataProvider, description: undefined as string | undefined, dispose: () => {} };
    createdTreeViews.push(view);

    return view;
  },
};

/** Applies a stub workspace edit to the given text, so a test can assert on the result. */
export function applyEdits(text: string, edits: StubTextEdit[]): string {
  const lines = text.split('\n');
  const ordered = [...edits].sort(
    (first, second) =>
      second.range.start.line - first.range.start.line ||
      second.range.start.character - first.range.start.character,
  );

  ordered.forEach(({ range, newText }) => {
    lines[range.start.line] =
      lines[range.start.line].slice(0, range.start.character) +
      newText +
      lines[range.end.line].slice(range.end.character);
  });

  return lines.join('\n');
}

export class CodeAction {
  command?: { command: string; title: string; arguments?: unknown[] };

  constructor(
    public readonly title: string,
    public readonly kind?: unknown,
  ) {}
}

/** A kind carries its value and builds the sub-kinds under it, as the real one does. */
class StubCodeActionKind {
  constructor(public readonly value: string) {}

  append(parts: string): StubCodeActionKind {
    return new StubCodeActionKind(this.value === '' ? parts : `${this.value}.${parts}`);
  }
}

export const CodeActionKind = {
  Empty: new StubCodeActionKind(''),
  Refactor: new StubCodeActionKind('refactor'),
  RefactorExtract: new StubCodeActionKind('refactor.extract'),
  RefactorInline: new StubCodeActionKind('refactor.inline'),
  RefactorRewrite: new StubCodeActionKind('refactor.rewrite'),
  RefactorMove: new StubCodeActionKind('refactor.move'),
};
