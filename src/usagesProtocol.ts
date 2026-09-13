import type { Token } from './phpTokens';

/** A place in a file as the webview hands it back: plain numbers, since a `Range` does not cross the bridge. */
export type UsagePlace = { line: number; character: number; endLine: number; endCharacter: number };

/** One usage as the panel draws it. */
export type PreparedEntry = {
  uri: string;
  place: UsagePlace;
  label: string;
  /** What else the line says about it: the fully qualified name of an implementation. */
  description: string | null;
  /** The label coloured as PHP, null when the label is not a line of code. */
  tokens: Token[] | null;
  /** Where the usage sits in the label, null when the label is not the line it was found on. */
  highlight: [number, number] | null;
};

export type PreparedFile = { name: string; directory: string; entries: PreparedEntry[] };

export type PreparedGroup = { label: string; total: number; files: PreparedFile[] };

/** A listing ready to draw: sorted, grouped by file, every line already coloured. */
export type PreparedListing = {
  subject: string;
  subjectTokens: Token[];
  /** "3 usages", "1 implementation": what the heading counts. */
  count: string;
  groups: PreparedGroup[];
};

/** From the extension to the webview. */
export type ToWebviewMessage = { type: 'listing'; listing: PreparedListing };

/** From the webview to the extension: the page is up and can be drawn on, or a line is asked for. */
export type FromWebviewMessage =
  | { type: 'ready' }
  | {
      type: 'open';
      uri: string;
      place: UsagePlace;
      /** Open next to the current editor rather than in it. */
      isBeside: boolean;
      /** Move the keyboard to the editor, as Enter does; a click keeps it in the panel. */
      shouldFocusEditor: boolean;
    };
