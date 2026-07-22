import * as vscode from 'vscode';
import { getIndex, onDidChangeFile } from '../workspaceIndex';
import { PositionMapper } from './positionMapper';
import { parseFile, type Declaration, type ParsedFile } from './parser';

/** One parsed file, kept together with the text it was parsed from. */
export interface IndexedFile {
  uri: vscode.Uri;
  text: string;
  parsed: ParsedFile;
  mapper: PositionMapper;
}

const PARSE_BATCH_SIZE = 40;

const cache = new Map<string, IndexedFile>();
let watching = false;

function forget(uri: vscode.Uri): void {
  cache.delete(uri.toString());
}

/** Unsaved edits are what the user sees, so they win over the indexed copy. */
function liveText(uri: vscode.Uri): string | null {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.isDirty && document.uri.toString() === uri.toString(),
  );

  return open ? open.getText() : null;
}

function build(uri: vscode.Uri, text: string): IndexedFile {
  return { uri, text, parsed: parseFile(text), mapper: new PositionMapper(text) };
}

/** Parsed form of a single file, reusing the cached one when the text has not moved. */
export function indexedFile(uri: vscode.Uri, text: string): IndexedFile {
  const key = uri.toString();
  const cached = cache.get(key);

  if (cached && cached.text === text) {
    return cached;
  }

  const built = build(uri, text);
  cache.set(key, built);
  return built;
}

/** Lets the event loop breathe: parsing a large project in one go freezes the UI. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Every project PHP file, parsed. Built on top of the text index, so the expensive part —
 * reading the files — is already paid for by the time a refactoring is asked for.
 */
export async function getPhpIndex(): Promise<IndexedFile[]> {
  if (!watching) {
    watching = true;
    onDidChangeFile(forget);
  }

  const files = await getIndex();
  const parsed: IndexedFile[] = [];
  let sinceYield = 0;

  for (const [key, indexedText] of files) {
    const uri = vscode.Uri.parse(key);
    const text = liveText(uri) ?? indexedText;

    parsed.push(indexedFile(uri, text));

    if (++sinceYield >= PARSE_BATCH_SIZE) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }

  return parsed;
}

/** The file declaring `fqn`, or null when the type lives outside the project. */
export async function findDeclaration(
  fqn: string,
): Promise<{ file: IndexedFile; declaration: Declaration } | null> {
  for (const file of await getPhpIndex()) {
    const declaration = file.parsed.declarations.find((candidate) => candidate.fqn === fqn);

    if (declaration) {
      return { file, declaration };
    }
  }

  return null;
}
