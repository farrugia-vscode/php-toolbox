import * as vscode from 'vscode';
import type { Member } from '../types';
import { InheritanceResolver } from '../inheritanceResolver';
import { parseTypeReferences } from '../typeReferences';
import { resolveTypeName, type ResolvedClass } from '../classResolution';

const MAX_DEPTH = 10;

/**
 * Members a class only gets through a `@mixin`, written anywhere up its own hierarchy.
 * Intelephense (1.18.5, measured) drops the annotation entirely, so everything a mixin
 * forwards is missing from what it offers: the columns ide-helper writes to a separate
 * `IdeHelperModel` class, and the query builder an Eloquent relation forwards to. Nothing
 * here is Laravel-specific: any library annotating a forwarding class this way has the
 * same hole.
 */
export async function mixinMembers(start: ResolvedClass): Promise<Member[]> {
  const seen = new Set<string>();
  const members = new Map<string, Member>();
  const queue: Array<{ target: ResolvedClass; depth: number }> = [{ target: start, depth: 0 }];

  while (queue.length > 0) {
    const { target, depth } = queue.shift() as { target: ResolvedClass; depth: number };
    const key = `${target.uri.toString()}#${target.symbol.name}`;

    if (depth > MAX_DEPTH || seen.has(key)) {
      continue;
    }
    seen.add(key);

    const document = await vscode.workspace.openTextDocument(target.uri);
    const { names, mixins, headerRange } = parseTypeReferences(document, target.symbol);
    const toLine = target.symbol.range.end.line;

    for (const mixin of mixins) {
      const resolved = await resolveTypeName(document, mixin.name, headerRange[0], toLine);

      if (!resolved) {
        continue;
      }

      const forwarded = await new InheritanceResolver().resolve(resolved.uri, resolved.symbol);

      for (const [name, member] of forwarded) {
        if (!members.has(name)) {
          members.set(name, member);
        }
      }
    }

    // Keep climbing: the mixin usually sits on a base class (`Relation`) rather than on the
    // leaf the code names (`BelongsTo`).
    for (const name of names) {
      if (mixins.some((mixin) => mixin.name === name)) {
        continue;
      }

      const parent = await resolveTypeName(document, name, headerRange[0], toLine);

      if (parent) {
        queue.push({ target: parent, depth: depth + 1 });
      }
    }
  }

  return [...members.values()];
}
