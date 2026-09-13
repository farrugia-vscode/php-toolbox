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
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position | number, end: Position | number, endLine?: number, endCharacter?: number) {
    this.start = start instanceof Position ? start : new Position(start, end as number);
    this.end = end instanceof Position ? end : new Position(endLine ?? 0, endCharacter ?? 0);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
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

/** The lines `openTextDocument` answers with, by uri; a uri missing from it is a file that is gone. */
export const documentLines = new Map<string, string[]>();

export const workspace = {
  textDocuments: [] as Array<{ isDirty: boolean; uri: Uri; getText(): string }>,
  openTextDocument: async (uri: Uri): Promise<{ lineCount: number; lineAt(line: number): { text: string } }> => {
    const lines = documentLines.get(uri.toString());

    if (!lines) {
      throw new Error(`cannot open ${uri.toString()}`);
    }

    return { lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] }) };
  },
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

export enum ViewColumn {
  Beside = -2,
}

/** What `registerWebviewViewProvider` was given, so a test can resolve the view by hand. */
export const registeredWebviewViews: Array<{ id: string; provider: any }> = [];

/** The messages posted to the stub webview, in order. */
export const postedMessages: unknown[] = [];

/** What the last `showTextDocument` was asked to open. */
export const shownDocuments: Array<{ uri: Uri; options: unknown }> = [];

/** A webview view as the provider sees it: it records what it is given and lets a test send a message back. */
export class StubWebviewView {
  description?: string;
  readonly webview = {
    options: {} as unknown,
    html: '',
    cspSource: 'stub-csp',
    asWebviewUri: (uri: Uri): string => `webview://${uri.path}`,
    postMessage: async (message: unknown): Promise<boolean> => {
      postedMessages.push(message);

      return true;
    },
    onDidReceiveMessage: (listener: (message: unknown) => void): Disposable => {
      this.listener = listener;

      return new Disposable(() => {});
    },
  };
  private listener: ((message: unknown) => void) | null = null;

  onDidDispose(): Disposable {
    return new Disposable(() => {});
  }

  receive(message: unknown): void {
    this.listener?.(message);
  }
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
  showTextDocument: async (uri: Uri, options: unknown): Promise<void> => {
    shownDocuments.push({ uri, options });
  },
  registerWebviewViewProvider: (id: string, provider: any): Disposable => {
    registeredWebviewViews.push({ id, provider });

    return new Disposable(() => {});
  },
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
