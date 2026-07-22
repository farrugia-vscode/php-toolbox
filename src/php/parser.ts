import { Engine } from 'php-parser';

export type DeclarationKind = 'class' | 'interface' | 'trait' | 'enum';

/** A type declared by the file, with the offsets of its short name. */
export interface Declaration {
  kind: DeclarationKind;
  name: string;
  fqn: string;
  start: number;
  end: number;
}

/** A `use X\Y;` import, with the offsets of the written name. */
export interface Import {
  fqn: string;
  alias: string;
  /** Shared prefix when the import sits in a `use A\{B, C};` group, empty otherwise. */
  groupPrefix: string;
  start: number;
  end: number;
}

/** How a name was written: fully qualified, qualified, relative or bare. */
export type Resolution = 'fqn' | 'qn' | 'rn' | 'uqn';

/** Any mention of a type in code, resolved to its fully qualified name. */
export interface Reference {
  fqn: string;
  resolution: Resolution;
  start: number;
  end: number;
}

export interface ParsedFile {
  namespace: string;
  /** Offsets of the namespace name itself, so a move can rewrite it in place. */
  namespaceRange: [number, number] | null;
  /** Offset the first import should be inserted at when the file has none. */
  importAnchor: number;
  imports: Import[];
  declarations: Declaration[];
  references: Reference[];
}

const DECLARATION_KINDS = new Set(['class', 'interface', 'trait', 'enum']);

/** Names the parser reports like any other, but which never point at a type. */
const RESERVED = new Set([
  'self', 'static', 'parent', 'int', 'float', 'string', 'bool', 'boolean', 'array',
  'callable', 'iterable', 'object', 'mixed', 'void', 'never', 'null', 'false', 'true',
]);

const engine = new Engine({
  parser: { extractDoc: false, suppressErrors: true, php7: true },
  ast: { withPositions: true },
});

function trimLeadingSeparator(name: string): string {
  return name.startsWith('\\') ? name.slice(1) : name;
}

/**
 * Turns a name as written into a fully qualified one, applying the same rules PHP does:
 * imports first, then the current namespace.
 */
function resolve(
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

function collectImports(node: any, text: string, imports: Import[], aliases: Map<string, string>): void {
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

/** Everything a rename needs to know about one file: what it declares and what it names. */
export function parseFile(text: string): ParsedFile {
  const parsed: ParsedFile = {
    namespace: '',
    namespaceRange: null,
    importAnchor: 0,
    imports: [],
    declarations: [],
    references: [],
  };
  const aliases = new Map<string, string>();

  let ast;
  try {
    ast = engine.parseCode(text, 'file.php');
  } catch {
    return parsed;
  }

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.kind === 'namespace' && typeof node.name === 'string' && !parsed.namespace) {
      parsed.namespace = node.name;
      const header = /^namespace\s+/.exec(text.slice(node.loc.start.offset, node.loc.start.offset + 32));
      if (header) {
        const start = node.loc.start.offset + header[0].length;
        parsed.namespaceRange = [start, start + node.name.length];
        parsed.importAnchor = text.indexOf('\n', start + node.name.length) + 1;
      }
    } else if (node.kind === 'usegroup') {
      collectImports(node, text, parsed.imports, aliases);
    } else if (DECLARATION_KINDS.has(node.kind) && node.name?.kind === 'identifier') {
      const name = node.name.name;
      parsed.declarations.push({
        kind: node.kind as DeclarationKind,
        name,
        fqn: parsed.namespace ? `${parsed.namespace}\\${name}` : name,
        start: node.name.loc.start.offset,
        end: node.name.loc.end.offset,
      });
    } else if (node.kind === 'name') {
      const fqn = resolve(node.name, node.resolution, parsed.namespace, aliases);
      if (fqn) {
        parsed.references.push({
          fqn,
          resolution: node.resolution as Resolution,
          start: node.loc.start.offset,
          end: node.loc.end.offset,
        });
      }
    }

    for (const key of Object.keys(node)) {
      if (key !== 'loc') {
        walk(node[key]);
      }
    }
  };

  walk(ast);

  // New imports go after the existing ones, or right under the namespace line.
  if (parsed.imports.length > 0) {
    parsed.importAnchor = text.indexOf('\n', parsed.imports[parsed.imports.length - 1].end) + 1;
  }

  return parsed;
}
