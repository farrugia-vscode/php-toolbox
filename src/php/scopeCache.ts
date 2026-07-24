import type { IndexedFile } from './phpIndex';
import { analyzeScopes, type FileScopes } from './scopes';

const cache = new WeakMap<IndexedFile, FileScopes>();

/**
 * Scopes of an indexed file, parsed once.
 *
 * Resolving what a receiver holds asks for the scopes of every file a search touches; the
 * index hands out a new object whenever the text changes, so the cache never goes stale.
 */
export function scopesOf(file: IndexedFile): FileScopes {
  const known = cache.get(file);

  if (known) {
    return known;
  }

  const scopes = analyzeScopes(file.text);
  cache.set(file, scopes);

  return scopes;
}
