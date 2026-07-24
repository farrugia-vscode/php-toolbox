import * as vscode from 'vscode';
import { analyzeScopes, type FileScopes } from './scopes';

let cached: { key: string; scopes: FileScopes } | null = null;

/**
 * Scopes of the document being edited, parsed once per version.
 *
 * The code action provider runs on every cursor move, and parsing a large file each time
 * is felt straight away in the editor.
 */
export function scopesFor(document: vscode.TextDocument): FileScopes {
  const key = `${document.uri.toString()}:${document.version}`;

  if (cached?.key !== key) {
    cached = { key, scopes: analyzeScopes(document.getText()) };
  }

  return cached.scopes;
}
