import { parseAst } from './engine';
import { collectImports, resolve, trimLeadingSeparator, type Import } from './names';
import {
  callFrom,
  constantFrom,
  methodFrom,
  propertyFrom,
  type ClassConstant,
  type MethodCall,
  type MethodDeclaration,
  type PropertyDeclaration,
} from './members';

export type { Import } from './names';

export type DeclarationKind = 'class' | 'interface' | 'trait' | 'enum';

/** A type declared by the file, with the offsets of its short name. */
export interface Declaration {
  kind: DeclarationKind;
  name: string;
  fqn: string;
  start: number;
  end: number;
  /** Offsets just inside the braces of the class body. */
  bodyStart: number;
  bodyEnd: number;
  isAbstract: boolean;
  /** Fully qualified parent, interfaces and traits, for the refactorings that walk a hierarchy. */
  parent: string | null;
  interfaces: string[];
  traits: string[];
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
  methods: MethodDeclaration[];
  properties: PropertyDeclaration[];
  constants: ClassConstant[];
  calls: MethodCall[];
}

const DECLARATION_KINDS = new Set(['class', 'interface', 'trait', 'enum']);

/** Everything a refactoring needs to know about one file: what it declares, names and calls. */
export function parseFile(text: string): ParsedFile {
  const parsed: ParsedFile = {
    namespace: '',
    namespaceRange: null,
    importAnchor: 0,
    imports: [],
    declarations: [],
    references: [],
    methods: [],
    properties: [],
    constants: [],
    calls: [],
  };
  const aliases = new Map<string, string>();

  const ast = parseAst(text);

  if (!ast) {
    return parsed;
  }

  const fqnOf = (node: any): string | null => {
    if (!node) {
      return null;
    }

    const written = typeof node.name === 'string' ? node.name : node.name?.name ?? '';
    return resolve(written, node.resolution ?? 'uqn', parsed.namespace, aliases);
  };

  const declare = (node: any): Declaration => {
    const name = node.name.name;
    const bodyStart = text.indexOf('{', node.name.loc.end.offset);

    return {
      kind: node.kind as DeclarationKind,
      name,
      fqn: parsed.namespace ? `${parsed.namespace}\\${name}` : name,
      start: node.name.loc.start.offset,
      end: node.name.loc.end.offset,
      bodyStart: bodyStart === -1 ? node.loc.end.offset : bodyStart + 1,
      bodyEnd: node.loc.end.offset - 1,
      isAbstract: node.isAbstract === true,
      parent: fqnOf(node.extends),
      interfaces: (node.implements ?? []).map(fqnOf).filter(Boolean) as string[],
      traits: [],
    };
  };

  const walk = (node: any, className: string): void => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, className));
      return;
    }

    let scope = className;

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
      const declaration = declare(node);
      parsed.declarations.push(declaration);
      scope = declaration.fqn;
    } else if (node.kind === 'usetrait') {
      const owner = parsed.declarations.find((candidate) => candidate.fqn === className);
      (node.traits ?? []).forEach((trait: any) => {
        const fqn = fqnOf(trait);
        if (fqn && owner) {
          owner.traits.push(fqn);
        }
      });
    } else if (node.kind === 'method' && node.name?.loc) {
      parsed.methods.push(methodFrom(node, text, className));
    } else if (node.kind === 'propertystatement') {
      (node.properties ?? []).forEach((property: any) =>
        parsed.properties.push(propertyFrom(property, text, className, node)),
      );
    } else if (node.kind === 'classconstant') {
      (node.constants ?? []).forEach((constant: any) =>
        parsed.constants.push(constantFrom(constant, className, node)),
      );
    } else if (node.kind === 'call') {
      const call = callFrom(node, text);
      if (call) {
        parsed.calls.push(call);
      }
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
        walk(node[key], scope);
      }
    }
  };

  walk(ast, '');

  // New imports go after the existing ones, or right under the namespace line.
  if (parsed.imports.length > 0) {
    parsed.importAnchor = text.indexOf('\n', parsed.imports[parsed.imports.length - 1].end) + 1;
  }

  return parsed;
}

export { trimLeadingSeparator };
