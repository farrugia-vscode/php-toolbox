import { docblockBefore, readType } from './docblock';
import { parseAst } from './engine';
import { collectImports, resolve, trimLeadingSeparator, type Import } from './names';
import {
  accessFrom,
  callFrom,
  instantiationFrom,
  promotedVisibility,
  constantFrom,
  methodFrom,
  propertyFrom,
  type AccessMode,
  type ClassConstant,
  type Instantiation,
  type MemberAccess,
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
  /** What the docblock above the declaration adds to it. */
  annotated: Annotations;
}

/** A member the docblock declares, `@property Customer $customer` or `@method static self query()`. */
export interface AnnotatedMember {
  name: string;
  /** The type as written after the tag, null for a `@method` that writes none. */
  type: string | null;
}

/**
 * Members and types a docblock adds to a class: ide-helper writes the columns and the
 * relations of a model this way, and `@mixin` pulls in a whole class of them.
 */
export interface Annotations {
  properties: AnnotatedMember[];
  methods: AnnotatedMember[];
  /** Fully qualified `@mixin` targets. */
  mixins: string[];
  /** What `@extends Builder<Customer>` (or `@implements`) is generic over, as written. */
  extendsArguments: string[];
}

const PROPERTY_TAG = /@property(?:-read|-write)?\s+/g;
const METHOD_TAG = /@method\s+(?:static\s+)?/g;
const MIXIN_TAG = /@mixin\s+(\\?[\w\\]+)/g;
const EXTENDS_TAG = /@(?:template-)?(?:extends|implements)\s+\\?[\w\\]+<([^>]*)>/;

/** What the tags of a docblock declare, the `@mixin` names resolved as the file would resolve them. */
function annotationsOf(docblock: string | null, resolveWritten: (written: string) => string | null): Annotations {
  const annotations: Annotations = { properties: [], methods: [], mixins: [], extendsArguments: [] };

  if (docblock === null) {
    return annotations;
  }

  for (const match of docblock.matchAll(PROPERTY_TAG)) {
    const { type, end } = readType(docblock, match.index + match[0].length);
    const name = /^\s+\$(\w+)/.exec(docblock.slice(end));

    if (name) {
      annotations.properties.push({ name: name[1], type });
    }
  }

  for (const match of docblock.matchAll(METHOD_TAG)) {
    const { type, end } = readType(docblock, match.index + match[0].length);
    // `@method static Order first()` writes a type before the name; `@method first()` writes none.
    const named = /^\s+(\w+)\s*\(/.exec(docblock.slice(end));
    const bare = /^(\w+)\s*\(/.exec(type);

    if (named) {
      annotations.methods.push({ name: named[1], type });
    } else if (bare) {
      annotations.methods.push({ name: bare[1], type: null });
    }
  }

  for (const match of docblock.matchAll(MIXIN_TAG)) {
    const fqn = resolveWritten(match[1]);

    if (fqn) {
      annotations.mixins.push(fqn);
    }
  }

  const extended = EXTENDS_TAG.exec(docblock);

  if (extended) {
    annotations.extendsArguments = extended[1].split(',').map((argument) => argument.trim()).filter((argument) => argument !== '');
  }

  return annotations;
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
  /** Plain functions, declared by the file outside any class: a helper, a Pest fixture. */
  functions: MethodDeclaration[];
  properties: PropertyDeclaration[];
  constants: ClassConstant[];
  calls: MethodCall[];
  accesses: MemberAccess[];
  instantiations: Instantiation[];
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
    functions: [],
    properties: [],
    constants: [],
    calls: [],
    accesses: [],
    instantiations: [],
  };
  const aliases = new Map<string, string>();
  const called = new WeakSet<object>();
  const written = new WeakMap<object, AccessMode>();

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

  /** The class a `new` names, with `self`, `static` and `parent` read from where it sits. */
  const instantiated = (node: any, scope: string): string | null => {
    const kind = node.what?.kind;

    if (kind === 'selfreference' || kind === 'staticreference') {
      return scope || null;
    }

    if (kind === 'parentreference') {
      return parsed.declarations.find((declaration) => declaration.fqn === scope)?.parent ?? null;
    }

    return fqnOf(node.what);
  };

  const LOOKUPS = new Set(['propertylookup', 'nullsafepropertylookup', 'staticlookup']);

  /**
   * Records what an assignment does to the member it targets, before the walk reaches it.
   *
   * Writing an element (`$this->items['k'] = 1`) or adding to a value (`$this->total += 1`)
   * reads the member first: the mode says so rather than rounding it up to a write.
   */
  const markWritten = (node: any, mode: AccessMode): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (node.kind === 'offsetlookup') {
      markWritten(node.what, 'readwrite');
      return;
    }

    // `[$a->x, $b->y] = $pair` and `list($a->x) = $pair` assign each entry.
    if (node.kind === 'array' || node.kind === 'list') {
      (node.items ?? []).forEach((item: any) => markWritten(item, mode));
      return;
    }

    if (node.kind === 'entry') {
      markWritten(node.value, mode);
      return;
    }

    if (LOOKUPS.has(node.kind)) {
      written.set(node, mode);
    }
  };

  const resolveWritten = (written: string): string | null =>
    resolve(written, written.startsWith('\\') ? 'fqn' : 'uqn', parsed.namespace, aliases);

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
      annotated: annotationsOf(docblockBefore(text, node.loc.start.offset), resolveWritten),
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
    } else if (node.kind === 'traituse') {
      const owner = parsed.declarations.find((candidate) => candidate.fqn === className);
      (node.traits ?? []).forEach((trait: any) => {
        const fqn = fqnOf(trait);
        if (fqn && owner) {
          owner.traits.push(fqn);
        }
      });
    } else if (node.kind === 'function' && node.name?.loc) {
      parsed.functions.push(methodFrom(node, text, ''));
    } else if (node.kind === 'method' && node.name?.loc) {
      const method = methodFrom(node, text, className);
      parsed.methods.push(method);
      // A promoted parameter declares a property; refactorings have to see it as one.
      (node.arguments ?? []).forEach((argument: any, index: number) => {
        const visibility = promotedVisibility(argument);
        const param = method.params[index];

        if (!visibility || !param) {
          return;
        }

        const written = text.indexOf(`$${param.name}`, param.start);

        parsed.properties.push({
          name: param.name,
          className,
          visibility,
          isStatic: false,
          hasAttributes: (argument.attrGroups ?? []).length > 0,
          type: param.type,
          docType: null,
          nameStart: written + 1,
          nameEnd: written + 1 + param.name.length,
          start: param.start,
          end: param.end,
        });
      });
    } else if (node.kind === 'propertystatement') {
      (node.properties ?? []).forEach((property: any) =>
        parsed.properties.push(propertyFrom(property, text, className, node)),
      );
    } else if (node.kind === 'classconstant') {
      (node.constants ?? []).forEach((constant: any) =>
        parsed.constants.push(constantFrom(constant, text, className, node)),
      );
    } else if (node.kind === 'call') {
      const call = callFrom(node, text);
      if (call) {
        parsed.calls.push(call);
        // The lookup under a call names the method, not a member of its own.
        called.add(node.what);
      }
    } else if (node.kind === 'new') {
      const instantiation = instantiationFrom(node, text, instantiated(node, scope));
      if (instantiation) {
        parsed.instantiations.push(instantiation);
      }
    } else if (node.kind === 'assign') {
      // `=` replaces the value, `+=` and `??=` need the old one first.
      markWritten(node.left, node.operator === '=' ? 'write' : 'readwrite');
    } else if (node.kind === 'assignref') {
      // `$alias = &$this->total`: whoever holds the alias can write through it.
      markWritten(node.left, 'write');
      markWritten(node.right, 'readwrite');
    } else if (node.kind === 'pre' || node.kind === 'post') {
      markWritten(node.what, 'readwrite');
    } else if (node.kind === 'unset') {
      (node.variables ?? []).forEach((variable: any) => markWritten(variable, 'write'));
    } else if (node.kind === 'foreach') {
      // Only the targets are written; the source is read, like any other expression.
      markWritten(node.key, 'write');
      markWritten(node.value, 'write');
    } else if (
      (node.kind === 'propertylookup' || node.kind === 'nullsafepropertylookup' || node.kind === 'staticlookup') &&
      !called.has(node)
    ) {
      const access = accessFrom(node, text, written.get(node) ?? 'read');
      if (access) {
        parsed.accesses.push(access);
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
