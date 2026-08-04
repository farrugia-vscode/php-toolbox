import * as path from 'path';
import { parseAst } from '../php/engine';

/** A quoted string in the source, with the offsets of its content (quotes excluded). */
export interface PathLiteral {
  value: string;
  start: number;
  end: number;
}

/**
 * A protocol makes the string a URL, not something on disk; a backslash makes it a
 * namespace. Everything else has to carry a separator or an extension to be worth a
 * disk lookup — plain words such as 'auth' would otherwise stat the whole workspace.
 */
export function looksLikePath(value: string): boolean {
  if (value === '' || value.includes('\\') || value.includes('://') || value.startsWith('#')) {
    return false;
  }

  return value.includes('/') || /\.\w{1,5}$/.test(value);
}

/** Content offsets of a php-parser string node, or null for heredoc and interpolated strings. */
function literalFrom(node: any): PathLiteral | null {
  const raw: unknown = node.raw;

  if (typeof raw !== 'string' || !/^['"]/.test(raw) || typeof node.value !== 'string') {
    return null;
  }

  return {
    value: node.value,
    start: node.loc.start.offset + 1,
    end: node.loc.end.offset - 1,
  };
}

/** Every plain string literal of the file that could name a path. */
export function pathLiterals(text: string): PathLiteral[] {
  const ast = parseAst(text);

  if (!ast) {
    return [];
  }

  const found: PathLiteral[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.kind === 'string' && node.loc) {
      const literal = literalFrom(node);

      if (literal && looksLikePath(literal.value)) {
        found.push(literal);
      }

      return;
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

  return found;
}

/**
 * Where a path written in `file` points. `__DIR__ . '/web/auth.php'` and a bare
 * `require 'auth.php'` both resolve against the directory of the file holding them, so
 * a leading separator is dropped rather than read as the root of the filesystem.
 */
export function resolveAgainstFile(file: string, value: string): string {
  return path.resolve(path.dirname(file), value.replace(/^\/+/, ''));
}

/** What has been typed inside the string literal being completed, if any. */
export interface TypedPath {
  /** Everything between the opening quote and the cursor. */
  prefix: string;
  /** Length of the segment after the last separator, the part a completion replaces. */
  segmentLength: number;
}

/** Intelephense already completes these on its own, and two lists show up twice. */
const COVERED_BY_INTELEPHENSE = /\b(?:require|require_once|include|include_once)\b[^;]*$/;

/**
 * Completions are offered once a separator has been typed: before that, the string is
 * still anything at all (a route name, a config key) and file names would only get in
 * the way.
 */
export function typedPath(lineUpToCursor: string): TypedPath | null {
  const quoted = lineUpToCursor.match(/(['"])([^'"]*)$/);

  if (!quoted || COVERED_BY_INTELEPHENSE.test(lineUpToCursor)) {
    return null;
  }

  const prefix = quoted[2];

  if (!prefix.includes('/')) {
    return null;
  }

  return {
    prefix,
    segmentLength: prefix.length - prefix.lastIndexOf('/') - 1,
  };
}

/** Directory a partially typed path is listing, resolved from the file holding it. */
export function directoryOf(file: string, prefix: string): string {
  return resolveAgainstFile(file, prefix.slice(0, prefix.lastIndexOf('/') + 1));
}
