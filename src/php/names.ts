/** Turning names as written into fully qualified ones, the way PHP resolves them. */

/** A `use X\Y;` import, with the offsets of the written name. */
export interface Import {
  fqn: string;
  alias: string;
  /** Shared prefix when the import sits in a `use A\{B, C};` group, empty otherwise. */
  groupPrefix: string;
  start: number;
  end: number;
}

/** Names the parser reports like any other, but which never point at a type. */
const RESERVED = new Set([
  'self', 'static', 'parent', 'int', 'float', 'string', 'bool', 'boolean', 'array',
  'callable', 'iterable', 'object', 'mixed', 'void', 'never', 'null', 'false', 'true',
]);

export function trimLeadingSeparator(name: string): string {
  return name.startsWith('\\') ? name.slice(1) : name;
}

/**
 * Turns a name as written into a fully qualified one, applying the same rules PHP does:
 * imports first, then the current namespace.
 */
export function resolve(
  written: string,
  resolution: string,
  namespace: string,
  aliases: Map<string, string>,
): string | null {
  const name = trimLeadingSeparator(written);

  if (resolution === 'fqn') {
    return name;
  }

  const segments = name.split('\\');

  if (segments.length === 1 && RESERVED.has(name.toLowerCase())) {
    return null;
  }

  if (resolution === 'rn') {
    return namespace ? `${namespace}\\${name}` : name;
  }

  const imported = aliases.get(segments[0].toLowerCase());

  if (imported) {
    return [imported, ...segments.slice(1)].join('\\');
  }

  return namespace ? `${namespace}\\${name}` : name;
}

/** Offsets of `written` inside a node whose location may also cover an `as` alias. */
function writtenRange(text: string, start: number, written: string): [number, number] {
  if (text.startsWith(written, start)) {
    return [start, start + written.length];
  }

  const found = text.indexOf(written, start);
  return found === -1 ? [start, start + written.length] : [found, found + written.length];
}

export function collectImports(
  node: any,
  text: string,
  imports: Import[],
  aliases: Map<string, string>,
): void {
  // A grouped import (`use A\{B, C};`) carries the shared prefix on the group itself.
  const prefix = typeof node.name === 'string' ? trimLeadingSeparator(node.name) : '';

  for (const item of node.items ?? []) {
    const type = item.type ?? node.type;

    // `use function` / `use const` do not import types.
    if (type) {
      continue;
    }

    const written = trimLeadingSeparator(item.name);
    const fqn = prefix ? `${prefix}\\${written}` : written;
    const alias = item.alias?.name ?? (written.split('\\').pop() ?? written);
    const [start, end] = writtenRange(text, item.loc.start.offset, written);

    imports.push({ fqn, alias, groupPrefix: prefix, start, end });
    aliases.set(alias.toLowerCase(), fqn);
  }
}
