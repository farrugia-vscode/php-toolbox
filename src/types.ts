import type * as vscode from 'vscode';

/** A class member (own or inherited) surfaced in the "Go to Symbol" quick pick. */
export interface Member {
  name: string;
  detail: string;
  kind: vscode.SymbolKind;
  className: string;
  uri: vscode.Uri;
  range: vscode.Range;
}

/** A resolved definition location (uri + start position). */
export interface Definition {
  uri: vscode.Uri;
  position: vscode.Position;
}
