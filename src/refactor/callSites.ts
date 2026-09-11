import { isInstanceFactory, onDidChangeProviders, type MemberAlias } from '../api';
import { findAssignments, lastAssignment, type AssignmentSite } from '../php/assignments';
import type { AccessMode, CallArgument, MemberAccess, MethodCall, MethodDeclaration } from '../php/members';
import { resolve } from '../php/names';
import type { Declaration } from '../php/parser';
import { getPhpIndex, type IndexedFile } from '../php/phpIndex';
import {
  classNamesOf,
  followChain,
  FOREIGN,
  isSelfType,
  splitChain,
  typeResolution,
  UNKNOWN,
  type ChainLink,
  type Resolution,
} from '../php/receiverType';
import { scopesOf } from '../php/scopeCache';
import { indexGeneration } from '../php/phpIndex';
import { enclosingScopes, type FileScopes } from '../php/scopes';

/** A method and the file that declares it. */
export interface MethodLocation {
  file: IndexedFile;
  method: MethodDeclaration;
}

/** What a member is: a method is reached by calls, the rest by accesses. */
export interface MemberRef {
  kind: 'method' | 'property' | 'staticProperty' | 'constant';
  name: string;
  className: string;
  /** The other names a framework reaches it by, looked for next to its own. */
  aliases?: MemberAlias[];
}

/**
 * The names a member is mentioned by, each with the kind of mention to look for.
 *
 * Two extensions may well hand over the same alias; a mention counted twice would say
 * the member is used more than it is.
 */
function mentionNames(member: MemberRef): Array<{ name: string; kind: MemberRef['kind'] }> {
  const names = new Map<string, { name: string; kind: MemberRef['kind'] }>();

  for (const mention of [{ name: member.name, kind: member.kind }, ...(member.aliases ?? [])]) {
    names.set(`${mention.kind}:${mention.name}`, mention);
  }

  return [...names.values()];
}

/** One mention of a member, wherever it is written. */
export interface MemberSite {
  file: IndexedFile;
  nameStart: number;
  nameEnd: number;
  /** What the mention does to the member. A method is called, so it stays undefined. */
  access?: AccessMode;
}

/**
 * An argument that hands a promoted property its value.
 *
 * It is a usage of the member without being a mention of its name: renaming the property
 * rewrites the `name:` of a named argument and must leave a positional one alone, where
 * writing the new name over the value would replace the value itself.
 */
export interface PromotedArgument extends MemberSite {
  /** Offsets of the `name:` label, null when the argument is positional. */
  labelStart: number | null;
  labelEnd: number | null;
}

/**
 * A mention nothing could attribute, kept apart rather than guessed at.
 *
 * A refactoring must not touch these — nothing says they reach the member — but it must
 * not pretend they do not exist either: they are the one place its result can be wrong.
 */
export interface MemberSearch {
  sites: MemberSite[];
  unresolved: MemberSite[];
  /** Kept out of `sites`: these are values, not the name a rename replaces. */
  arguments: PromotedArgument[];
}

export interface CallSite {
  file: IndexedFile;
  call: MethodCall;
}

export interface CallSearch {
  sites: CallSite[];
  unresolved: CallSite[];
}

/** The project's own types. What it does not declare is someone else's and stays untouched. */
export interface Project {
  files: IndexedFile[];
  owners: Map<string, IndexedFile>;
  declarations: Map<string, Declaration>;
}

export async function projectOf(): Promise<Project> {
  return projectFrom(await getPhpIndex());
}

/** The same, over files already at hand: what a provider running on one file works from. */
export function projectFrom(files: IndexedFile[]): Project {
  const owners = new Map<string, IndexedFile>();
  const declarations = new Map<string, Declaration>();

  for (const file of files) {
    for (const declaration of file.parsed.declarations) {
      owners.set(declaration.fqn, file);
      declarations.set(declaration.fqn, declaration);
    }
  }

  return { files, owners, declarations };
}

const aliasCache = new WeakMap<IndexedFile, Map<string, string>>();
const assignmentCache = new WeakMap<IndexedFile, AssignmentSite[]>();

function aliasesOf(file: IndexedFile): Map<string, string> {
  const cached = aliasCache.get(file);

  if (cached) {
    return cached;
  }

  const aliases = new Map(file.parsed.imports.map((entry) => [entry.alias.toLowerCase(), entry.fqn]));
  aliasCache.set(file, aliases);

  return aliases;
}

function assignmentsIn(file: IndexedFile): AssignmentSite[] {
  const cached = assignmentCache.get(file);

  if (cached) {
    return cached;
  }

  const found = findAssignments(file.text);
  assignmentCache.set(file, found);

  return found;
}

/** A name as written, turned into the fully qualified one it means in this file. */
function resolveName(file: IndexedFile, written: string): string | null {
  return resolve(written, written.startsWith('\\') ? 'fqn' : 'uqn', file.parsed.namespace, aliasesOf(file));
}

/** A type the project declares, or a foreign one: there is no third answer for a named class. */
function knownResolution(project: Project, fqn: string | null): Resolution {
  return fqn && project.declarations.has(fqn) ? typeResolution(fqn) : FOREIGN;
}

function nameResolution(project: Project, file: IndexedFile, written: string): Resolution {
  return knownResolution(project, resolveName(file, written));
}

/** The class a declared type names: a union answers with the first of ours it lists. */
function writtenResolution(project: Project, file: IndexedFile, written: string): Resolution {
  const names = classNamesOf(written);

  if (names.length === 0) {
    return FOREIGN;
  }

  for (const name of names) {
    const found = knownResolution(project, resolveName(file, name));

    if (found.kind === 'type') {
      return found;
    }
  }

  return FOREIGN;
}

/** The innermost type declared around an offset: what `$this` points at there. */
function enclosingOf(file: IndexedFile, offset: number): Declaration | null {
  const enclosing = file.parsed.declarations.filter(
    (declaration) => declaration.bodyStart <= offset && declaration.bodyEnd >= offset,
  );

  return enclosing.sort((first, second) => first.bodyEnd - first.bodyStart - (second.bodyEnd - second.bodyStart))[0] ?? null;
}

/**
 * The type a member of `fqn` answers with, looked up through the hierarchy.
 *
 * A hierarchy that leaves the project answers `foreign`: the member is declared by a
 * dependency, so it is not ours whatever its name says.
 */
function memberType(project: Project, fqn: string, link: ChainLink): Resolution {
  const seen = new Set<string>();
  const queue = [fqn];
  let leavesProject = false;

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const owner = project.owners.get(current);
    const declaration = project.declarations.get(current);

    if (!owner || !declaration) {
      leavesProject = true;
      continue;
    }

    const written = memberTypeText(owner, current, link);

    if (written !== undefined) {
      if (written === null) {
        return UNKNOWN;
      }

      return isSelfType(written) ? typeResolution(fqn) : writtenResolution(project, owner, written);
    }

    queue.push(declaration.parent ?? '', ...declaration.interfaces, ...declaration.traits);
  }

  return leavesProject ? FOREIGN : UNKNOWN;
}

/** The type written on a member, `null` when it declares none and `undefined` when absent. */
function memberTypeText(file: IndexedFile, className: string, link: ChainLink): string | null | undefined {
  const method = file.parsed.methods.find(
    (candidate) => candidate.className === className && candidate.name === link.name,
  );
  const property = file.parsed.properties.find(
    (candidate) => candidate.className === className && candidate.name === link.name,
  );
  const found = link.isCall ? (method ?? property) : (property ?? method);

  if (!found) {
    return undefined;
  }

  return 'returnType' in found ? found.returnType : found.type;
}

/** How deep a variable is followed through the variables it was assigned from. */
const MAX_ASSIGNMENT_DEPTH = 4;

/**
 * The type the parameter `$name` declares, read from the innermost scope that has one.
 *
 * An arrow function or a closure reads the variables of the method it is written in, so
 * the parameter that types `$order` inside `fn ($line) => $order->total()` is the method's.
 */
function declaredParamType(scopes: FileScopes, name: string, offset: number): string | null {
  for (const scope of enclosingScopes(scopes, offset, offset)) {
    const param = scope.params.find((candidate) => candidate.name === name);

    if (param) {
      return param.type;
    }
  }

  return null;
}

/** `app(Customer::class)` written as the start of a chain: the callee, and the class it is handed. */
const FACTORY_CALL = /^(\\?[A-Za-z_][\w\\]*)\s*\(\s*(\\?[A-Za-z_][\w\\]*)::class\s*\)$/;

function variableResolution(
  project: Project,
  file: IndexedFile,
  name: string,
  offset: number,
  depth: number,
): Resolution {
  const declared = declaredParamType(scopesOf(file), name, offset);

  if (declared) {
    return writtenResolution(project, file, declared);
  }

  const assigned = depth < MAX_ASSIGNMENT_DEPTH ? lastAssignment(assignmentsIn(file), name, offset) : null;

  if (!assigned) {
    return UNKNOWN;
  }

  if (assigned.kind === 'instantiation') {
    return nameResolution(project, file, assigned.className);
  }

  if (assigned.kind === 'factoryCall') {
    return isInstanceFactory(assigned.callee) ? nameResolution(project, file, assigned.className) : UNKNOWN;
  }

  if (assigned.kind === 'staticMember') {
    const owner = nameResolution(project, file, assigned.className);

    return owner.kind === 'type'
      ? memberType(project, owner.fqn, { name: assigned.name, isCall: true })
      : owner;
  }

  const receiver =
    assigned.receiver.kind === 'this'
      ? knownResolution(project, enclosingOf(file, offset)?.fqn ?? null)
      : variableResolution(project, file, assigned.receiver.name, offset, depth + 1);

  return receiver.kind === 'type' ? memberType(project, receiver.fqn, { name: assigned.name, isCall: true }) : receiver;
}

/** The expression a chain starts from: `$this`, a type name, a `new`, or a variable. */
function rootResolution(project: Project, file: IndexedFile, root: string, offset: number): Resolution {
  const trimmed = root.trim();
  const lowered = trimmed.toLowerCase();

  if (trimmed === '$this' || lowered === 'self' || lowered === 'static') {
    return knownResolution(project, enclosingOf(file, offset)?.fqn ?? null);
  }

  if (lowered === 'parent') {
    return knownResolution(project, enclosingOf(file, offset)?.parent ?? null);
  }

  const instantiated = /^new\s+(\\?[A-Za-z_][\w\\]*)/.exec(trimmed);

  if (instantiated) {
    return nameResolution(project, file, instantiated[1]);
  }

  const built = FACTORY_CALL.exec(trimmed);

  if (built) {
    return isInstanceFactory(built[1]) ? nameResolution(project, file, built[2]) : UNKNOWN;
  }

  if (/^\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*$/.test(trimmed)) {
    return nameResolution(project, file, trimmed);
  }

  const variable = /^\$(\w+)$/.exec(trimmed);

  if (variable) {
    return variableResolution(project, file, variable[1], offset, 0);
  }

  return UNKNOWN;
}

/**
 * The type a mention is written on, whatever its receiver is made of.
 *
 * This is the whole safety of a rename: a call is rewritten because the receiver was
 * proven to hold the class, never because the method happens to share its name.
 */
export function mentionResolution(
  project: Project,
  file: IndexedFile,
  mention: Pick<MemberAccess, 'receiverKind' | 'receiverText' | 'nameStart'>,
): Resolution {
  const offset = mention.nameStart;

  if (mention.receiverKind === 'this' || mention.receiverKind === 'self' || mention.receiverKind === 'static') {
    return knownResolution(project, enclosingOf(file, offset)?.fqn ?? null);
  }

  if (mention.receiverKind === 'parent') {
    return knownResolution(project, enclosingOf(file, offset)?.parent ?? null);
  }

  if (mention.receiverKind === 'type') {
    return nameResolution(project, file, mention.receiverText);
  }

  const chain = splitChain(mention.receiverText);
  const root = rootResolution(project, file, chain.root, offset);

  return followChain(root, chain.links, { memberType: (fqn, link) => memberType(project, fqn, link) });
}

/**
 * The method `fqn` answers to, declared by it or by anything it inherits from.
 *
 * A call is written on the class, not on the class that happens to declare the method: the
 * signature it fills has to be looked up the same way PHP looks it up.
 */
export function declaredMethod(project: Project, fqn: string, name: string): MethodDeclaration | null {
  for (const candidate of [fqn, ...ancestorsOf(project, fqn)]) {
    const found = project.owners
      .get(candidate)
      ?.parsed.methods.find((method) => method.className === candidate && method.name === name);

    if (found) {
      return found;
    }
  }

  return null;
}

/** Every type the declaration inherits from, however deep, within the project. */
function ancestorsOf(project: Project, fqn: string): string[] {
  const seen = new Set<string>();
  const declaration = project.declarations.get(fqn);
  const queue = declaration ? [declaration.parent ?? '', ...declaration.interfaces, ...declaration.traits] : [];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const found = project.declarations.get(current);

    if (found) {
      queue.push(found.parent ?? '', ...found.interfaces, ...found.traits);
    }
  }

  return [...seen];
}

function declaresMember(project: Project, fqn: string, member: MemberRef): boolean {
  const file = project.owners.get(fqn);

  if (!file) {
    return false;
  }

  const declared =
    member.kind === 'method'
      ? file.parsed.methods
      : member.kind === 'constant'
        ? file.parsed.constants
        : file.parsed.properties;

  return declared.some((candidate) => candidate.className === fqn && candidate.name === member.name);
}

/**
 * Every class a call to the member can be written on: the one declaring it, the contracts
 * above it that promise it, and everything below them that inherits or overrides it.
 *
 * Renaming a method renames the interface too, so every class bound by that interface has
 * to follow — including the ones that never name the class the rename started from.
 */
export function memberFamily(project: Project, member: MemberRef): Set<string> {
  const children = new Map<string, string[]>();

  for (const [fqn, declaration] of project.declarations) {
    for (const parent of [declaration.parent ?? '', ...declaration.interfaces, ...declaration.traits]) {
      if (parent) {
        children.set(parent, [...(children.get(parent) ?? []), fqn]);
      }
    }
  }

  const family = new Set([member.className]);
  const queue = [member.className];

  while (queue.length > 0) {
    const fqn = queue.shift()!;
    const relatives = [
      ...ancestorsOf(project, fqn).filter((ancestor) => declaresMember(project, ancestor, member)),
      ...(children.get(fqn) ?? []),
    ];

    for (const relative of relatives) {
      if (!family.has(relative)) {
        family.add(relative);
        queue.push(relative);
      }
    }
  }

  return family;
}

/** Every mention of a member across the project, calls or accesses depending on its kind. */
export async function findMemberSites(member: MemberRef): Promise<MemberSearch> {
  const project = await projectOf();
  const family = memberFamily(project, member);
  const sites: MemberSite[] = [];
  const unresolved: MemberSite[] = [];

  for (const file of project.files) {
    const mentions = mentionNames(member).flatMap(
      ({ name, kind }): Array<
        Pick<MemberAccess, 'receiverKind' | 'receiverText' | 'nameStart' | 'nameEnd'> & { access?: AccessMode }
      > =>
        kind === 'method'
          ? file.parsed.calls.filter((call) => call.name === name)
          : file.parsed.accesses.filter((access) => access.name === name && access.kind === kind),
    );

    for (const mention of mentions) {
      const resolution = mentionResolution(project, file, mention);
      const site = { file, nameStart: mention.nameStart, nameEnd: mention.nameEnd, access: mention.access };

      if (resolution.kind === 'type' && family.has(resolution.fqn)) {
        sites.push(site);
      } else if (resolution.kind === 'unknown') {
        unresolved.push(site);
      }
    }
  }

  return { sites, unresolved, arguments: promotedWrites(project, family, member) };
}

/** How often a property is read and how often it is written, for a listing that shows both. */
export interface AccessCount {
  read: number;
  written: number;
}

/** Key a count is stored under: a name alone would collide between two classes. */
export function accessKey(member: Pick<MemberRef, 'className' | 'name'>): string {
  return `${member.className}::${member.name}`;
}

/** Key a count is kept under: the same member asked with other aliases is another question. */
function countKey(member: MemberRef): string {
  return `${accessKey(member)}${(member.aliases ?? []).map((alias) => ` ${alias.kind}:${alias.name}`).join('')}`;
}

/**
 * Reads and writes of several members, counted in a single pass over the project.
 *
 * A lens asks the question for every member of the file at once, and a pass per member
 * would read the whole project as many times as the class has fields. A method is only
 * ever called, so its calls land in `read` and its `written` stays at zero.
 */
const counted = new Map<string, AccessCount>();
let countedAt = -1;

// What another extension registers changes which receivers resolve, so every count is due again.
onDidChangeProviders(() => {
  counted.clear();
  countedAt = -1;
});

/**
 * Counts kept until the project moves. A lens re-runs on every scroll and every switch
 * back to a file, and the answer cannot have changed unless something was parsed again.
 */
function cachedCounts(members: MemberRef[]): Map<string, AccessCount> | null {
  const generation = indexGeneration();

  if (generation !== countedAt) {
    counted.clear();
    countedAt = generation;

    return null;
  }

  const known = new Map<string, AccessCount>();

  for (const member of members) {
    const count = counted.get(countKey(member));

    if (count === undefined) {
      return null;
    }

    known.set(accessKey(member), count);
  }

  return known;
}

export async function countMemberUsages(members: MemberRef[]): Promise<Map<string, AccessCount>> {
  const known = cachedCounts(members);

  if (known !== null) {
    return known;
  }

  const project = await projectOf();
  const counts = new Map<string, AccessCount>();
  const families = new Map<string, Set<string>>();
  const byName = new Map<string, Array<{ member: MemberRef; kind: MemberRef['kind'] }>>();

  for (const member of members) {
    const key = accessKey(member);
    const family = memberFamily(project, member);

    families.set(key, family);
    counts.set(key, {
      read: 0,
      written: member.kind === 'method' ? 0 : promotedWrites(project, family, member).length,
    });

    for (const { name, kind } of mentionNames(member)) {
      byName.set(name, [...(byName.get(name) ?? []), { member, kind }]);
    }
  }

  for (const file of project.files) {
    for (const call of file.parsed.calls) {
      for (const { member, kind } of byName.get(call.name) ?? []) {
        if (kind !== 'method') {
          continue;
        }

        const resolution = mentionResolution(project, file, call);
        const key = accessKey(member);

        if (resolution.kind === 'type' && families.get(key)?.has(resolution.fqn)) {
          counts.get(key)!.read += 1;
        }
      }
    }

    for (const access of file.parsed.accesses) {
      for (const { member, kind } of byName.get(access.name) ?? []) {
        if (access.kind !== kind) {
          continue;
        }

        const resolution = mentionResolution(project, file, access);
        const key = accessKey(member);

        if (resolution.kind !== 'type' || !families.get(key)?.has(resolution.fqn)) {
          continue;
        }

        const count = counts.get(key)!;

        if (access.access !== 'write') {
          count.read += 1;
        }

        if (access.access !== 'read') {
          count.written += 1;
        }
      }
    }
  }

  for (const member of members) {
    counted.set(countKey(member), counts.get(accessKey(member))!);
  }

  return counts;
}

/** True when building `fqn` runs the constructor `className` declares, argument order included. */
function keepsConstructorOf(project: Project, fqn: string, className: string): boolean {
  if (fqn === className) {
    return true;
  }

  const file = project.owners.get(fqn);

  return !file?.parsed.methods.some((method) => method.className === fqn && method.name === '__construct');
}

/**
 * The arguments that hand a promoted property its value, `new Order(total: 10)` included.
 *
 * They are written where the class is built, not where the property is declared, so nothing
 * in `accesses` can carry them: without this pass a promoted property reads as never written.
 */
function promotedWrites(project: Project, family: Set<string>, member: MemberRef): PromotedArgument[] {
  if (member.kind !== 'property') {
    return [];
  }

  const owner = project.owners.get(member.className);
  const constructor = owner?.parsed.methods.find(
    (method) => method.className === member.className && method.name === '__construct',
  );
  const index = constructor?.params.findIndex((param) => param.isPromoted && param.name === member.name) ?? -1;

  if (index === -1) {
    return [];
  }

  const sites: PromotedArgument[] = [];

  for (const file of project.files) {
    // `new Order(...)` builds it, `parent::__construct(...)` hands the value up: both write.
    const builders: Array<{ fqn: string | null; args: CallArgument[]; hasSpread: boolean }> = [
      ...file.parsed.instantiations,
      ...file.parsed.calls
        .filter((call) => call.name === '__construct')
        .map((call) => {
          const resolution = mentionResolution(project, file, call);

          return { fqn: resolution.kind === 'type' ? resolution.fqn : null, args: call.args, hasSpread: call.hasSpread };
        }),
    ];

    for (const builder of builders) {
      if (!builder.fqn || !family.has(builder.fqn)) {
        continue;
      }

      const named = builder.args.find((argument) => argument.label === member.name);
      // A spread hides which position holds what, and a subclass with a constructor of its
      // own puts something else at that position: only a named argument survives both.
      const byPosition = !builder.hasSpread && keepsConstructorOf(project, builder.fqn, member.className);
      const positional = byPosition ? builder.args[index] : undefined;
      const argument = named ?? (positional?.label === null ? positional : undefined);

      if (argument) {
        sites.push({
          file,
          nameStart: argument.start,
          nameEnd: argument.end,
          access: 'write',
          labelStart: argument.label === null ? null : argument.start,
          labelEnd: argument.label === null ? null : argument.start + argument.label.length,
        });
      }
    }
  }

  return sites;
}

/** Every call that reaches the given method, and the ones nothing could attribute. */
export async function findCallSites(method: MethodDeclaration): Promise<CallSearch> {
  const project = await projectOf();
  const family = memberFamily(project, { kind: 'method', name: method.name, className: method.className });
  const sites: CallSite[] = [];
  const unresolved: CallSite[] = [];

  for (const file of project.files) {
    for (const call of file.parsed.calls) {
      if (call.name !== method.name) {
        continue;
      }

      const resolution = mentionResolution(project, file, call);

      if (resolution.kind === 'type' && family.has(resolution.fqn)) {
        sites.push({ file, call });
      } else if (resolution.kind === 'unknown') {
        unresolved.push({ file, call });
      }
    }
  }

  return { sites, unresolved };
}

/** Walks up the hierarchy until a class in the project declares the method. */
async function declaredIn(className: string, name: string): Promise<MethodLocation | null> {
  const project = await projectOf();
  const seen = new Set<string>();
  let current: string | null = className;

  while (current && !seen.has(current)) {
    seen.add(current);
    const owner: string = current;

    for (const file of project.files) {
      const method = file.parsed.methods.find(
        (candidate) => candidate.className === owner && candidate.name === name,
      );

      if (method) {
        return { file, method };
      }
    }

    const declaration = project.declarations.get(owner);
    const inherited: string[] = declaration ? [...declaration.traits, declaration.parent ?? ''] : [];

    current = inherited.filter(Boolean)[0] ?? null;
  }

  return null;
}

/** The class a receiver was proven to hold, or null when nothing said what it holds. */
export async function receiverFqn(
  file: IndexedFile,
  receiverText: string,
  offset: number,
): Promise<string | null> {
  const project = await projectOf();
  const resolution = mentionResolution(project, file, {
    receiverKind: 'expression',
    receiverText,
    nameStart: offset,
  });

  return resolution.kind === 'type' ? resolution.fqn : null;
}

/**
 * The method the cursor points at, whether it sits on the declaration or on a call.
 *
 * Working from a call is what people expect — you notice a method is pointless where you
 * are reading it, not where it is written.
 */
export async function methodAtCursor(file: IndexedFile, offset: number): Promise<MethodLocation | null> {
  const declared = file.parsed.methods.find(
    (candidate) => offset >= candidate.nameStart && offset <= candidate.nameEnd,
  );

  if (declared) {
    return { file, method: declared };
  }

  const call = file.parsed.calls.find((candidate) => offset >= candidate.nameStart && offset <= candidate.nameEnd);

  if (!call) {
    return null;
  }

  const project = await projectOf();
  const resolution = mentionResolution(project, file, call);

  if (resolution.kind === 'type') {
    return declaredIn(resolution.fqn, call.name);
  }

  const enclosing = enclosingOf(file, offset);

  return enclosing ? declaredIn(enclosing.fqn, call.name) : null;
}

/**
 * The same method as declared by relatives of the class: an override in a child, the
 * declaration in the interface it implements. A signature that changes on one of them and
 * not the others stops matching.
 */
export async function relatedMethods(method: MethodDeclaration): Promise<MethodLocation[]> {
  const project = await projectOf();
  const family = memberFamily(project, {
    kind: 'method',
    name: method.name,
    className: method.className,
  });

  return project.files.flatMap((file) =>
    file.parsed.methods
      .filter((candidate) => candidate.name === method.name && family.has(candidate.className))
      .map((candidate) => ({ file, method: candidate })),
  );
}
