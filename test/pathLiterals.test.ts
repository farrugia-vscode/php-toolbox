import { describe, expect, test } from 'bun:test';
import { directoryOf, looksLikePath, pathLiterals, resolveAgainstFile, typedPath } from '../src/paths/pathLiterals';

const ROUTES = `<?php

use Illuminate\\Support\\Facades\\Route;

require __DIR__ . '/web/public.php';

Route::middleware(['auth', 'verified'])->group(__DIR__ . '/web/private.php');
`;

describe('finding the strings that name a path', () => {
  test('keeps the required files and drops the middleware names', () => {
    expect(pathLiterals(ROUTES).map((literal) => literal.value)).toEqual([
      '/web/public.php',
      '/web/private.php',
    ]);
  });

  test('offsets cover the string content, quotes excluded', () => {
    const [first] = pathLiterals(ROUTES);

    expect(ROUTES.slice(first.start, first.end)).toBe('/web/public.php');
  });

  test('a namespace is not a path', () => {
    expect(looksLikePath('App\\Models\\User')).toBe(false);
    expect(looksLikePath('https://example.com/a.php')).toBe(false);
    expect(looksLikePath('auth')).toBe(false);
    expect(looksLikePath('helpers.php')).toBe(true);
  });
});

describe('resolving against the file being edited', () => {
  test('a leading separator stays relative to the file', () => {
    expect(resolveAgainstFile('/app/routes/web.php', '/web/auth.php')).toBe('/app/routes/web/auth.php');
    expect(resolveAgainstFile('/app/routes/web.php', 'auth.php')).toBe('/app/routes/auth.php');
  });
});

describe('completing a path being typed', () => {
  test('waits for a separator before offering anything', () => {
    expect(typedPath("Route::group(__DIR__ . 'we")).toBeNull();
    expect(typedPath("Route::group(__DIR__ . '/web/pu")).toEqual({ prefix: '/web/pu', segmentLength: 2 });
  });

  test('stays out of require and include, which Intelephense completes already', () => {
    expect(typedPath("require __DIR__ . '/web/pu")).toBeNull();
    expect(typedPath("include_once __DIR__ . '/web/")).toBeNull();
  });

  test('ignores a string that is already closed', () => {
    expect(typedPath("Route::group(__DIR__ . '/web/public.php');")).toBeNull();
  });

  test('lists the directory of the segment being typed', () => {
    expect(directoryOf('/app/routes/web.php', '/web/pu')).toBe('/app/routes/web');
  });
});
