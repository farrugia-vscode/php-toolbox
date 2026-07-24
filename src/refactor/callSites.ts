import type { MethodCall, MethodDeclaration } from '../php/members';
import { getPhpIndex, type IndexedFile } from '../php/phpIndex';

/** One call, and whether the receiver leaves any doubt about which method it reaches. */
export interface CallSite {
  file: IndexedFile;
  call: MethodCall;
  isCertain: boolean;
}

export interface CallSearch {
  sites: CallSite[];
  /** Another class in the project declares a method with the same name. */
  isNameShared: boolean;
}

/** A method and the file that declares it. */
export interface MethodLocation {
  file: IndexedFile;
  method: MethodDeclaration;
}

/** Walks up the hierarchy until a class in the project declares the method. */
async function declaredIn(className: string, name: string): Promise<MethodLocation | null> {
  const files = await getPhpIndex();
  const seen = new Set<string>();
  let current: string | null = className;

  while (current && !seen.has(current)) {
    seen.add(current);
    const owner: string = current;

    for (const file of files) {
      const method = file.parsed.methods.find(
        (candidate) => candidate.className === owner && candidate.name === name,
      );

      if (method) {
        return { file, method };
      }
    }

    const declaration = files
      .flatMap((file) => file.parsed.declarations)
      .find((candidate) => candidate.fqn === owner);
    const inherited: string[] = declaration ? [...declaration.traits, declaration.parent ?? ''] : [];

    current = inherited.filter(Boolean)[0] ?? null;
  }

  return null;
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

  if (call.receiverKind === 'type' || call.receiverKind === 'parent') {
    const fqn = staticReceiverFqn(file, call);

    return fqn ? declaredIn(fqn, call.name) : null;
  }

  const enclosing = file.parsed.declarations.find(
    (declaration) => declaration.bodyStart <= offset && declaration.bodyEnd >= offset,
  );

  return enclosing ? declaredIn(enclosing.fqn, call.name) : null;
}

/**
 * The same method as declared by relatives of the class: an override in a child, the
 * declaration in the interface it implements. A signature that changes on one of them and
 * not the others stops matching.
 */
export async function relatedMethods(method: MethodDeclaration): Promise<MethodLocation[]> {
  const files = await getPhpIndex();
  const declarations = files.flatMap((file) => file.parsed.declarations);
  const own = declarations.find((declaration) => declaration.fqn === method.className);
  const family = new Set<string>([
    ...(own ? [own.parent ?? '', ...own.interfaces, ...own.traits] : []),
    ...declarations
      .filter(
        (declaration) =>
          declaration.parent === method.className ||
          declaration.interfaces.includes(method.className) ||
          declaration.traits.includes(method.className),
      )
      .map((declaration) => declaration.fqn),
  ].filter(Boolean));

  return files.flatMap((file) =>
    file.parsed.methods
      .filter((candidate) => candidate.name === method.name && family.has(candidate.className))
      .map((candidate) => ({ file, method: candidate })),
  );
}

/** Fully qualified name the receiver of a static call was written as. */
function staticReceiverFqn(file: IndexedFile, call: MethodCall): string | null {
  const reference = file.parsed.references.find(
    (candidate) => candidate.end <= call.nameStart && candidate.start >= call.start,
  );

  return reference?.fqn ?? null;
}

/** Types declared in the file that inherit the method, which is what `$this->` reaches. */
function declaresFamily(file: IndexedFile, className: string): boolean {
  return file.parsed.declarations.some(
    (declaration) =>
      declaration.fqn === className ||
      declaration.parent === className ||
      declaration.traits.includes(className) ||
      declaration.interfaces.includes(className),
  );
}

/**
 * Every call that reaches the given method.
 *
 * A receiver written as `$this` or as the class name is certain; a call on a variable is
 * matched by name only, because nothing here knows what that variable holds.
 */
export async function findCallSites(method: MethodDeclaration): Promise<CallSearch> {
  const files = await getPhpIndex();
  const sites: CallSite[] = [];
  let isNameShared = false;

  for (const file of files) {
    isNameShared =
      isNameShared ||
      file.parsed.methods.some(
        (candidate) => candidate.name === method.name && candidate.className !== method.className,
      );

    for (const call of file.parsed.calls) {
      if (call.name !== method.name) {
        continue;
      }

      if (call.receiverKind === 'type' || call.receiverKind === 'parent') {
        const fqn = staticReceiverFqn(file, call);

        if (fqn === method.className) {
          sites.push({ file, call, isCertain: true });
        }
        continue;
      }

      if (call.receiverKind === 'this' || call.receiverKind === 'self' || call.receiverKind === 'static') {
        // A deeper descendant reaches the method too, without naming it anywhere.
        sites.push({ file, call, isCertain: declaresFamily(file, method.className) });
        continue;
      }

      sites.push({ file, call, isCertain: false });
    }
  }

  return { sites, isNameShared };
}
