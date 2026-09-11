import * as vscode from 'vscode';
import type { MethodDeclaration } from './php/members';
import type { Declaration } from './php/parser';
import { getPhpIndex, indexedFile, type IndexedFile } from './php/phpIndex';
import { withProgress } from './refactor/apply';
import { methodAtCursor } from './refactor/callSites';
import { showUsagesView } from './usagesView';

interface Implementation {
  file: IndexedFile;
  method: MethodDeclaration;
  className: string;
}

/** Every type the declaration inherits from, however deep. */
function ancestorsOf(declaration: Declaration, all: Map<string, Declaration>): Set<string> {
  const seen = new Set<string>();
  const queue = [declaration.parent ?? '', ...declaration.interfaces, ...declaration.traits].filter(Boolean);

  while (queue.length > 0) {
    const fqn = queue.shift()!;

    if (seen.has(fqn)) {
      continue;
    }

    seen.add(fqn);
    const found = all.get(fqn);

    if (found) {
      queue.push(found.parent ?? '', ...found.interfaces, ...found.traits);
    }
  }

  return seen;
}

/** Classes that end up carrying a body for the method, however far down the hierarchy. */
async function implementationsOf(method: MethodDeclaration): Promise<Implementation[]> {
  const files = await getPhpIndex();
  const all = new Map(files.flatMap((file) => file.parsed.declarations).map((declaration) => [declaration.fqn, declaration]));
  const found: Implementation[] = [];

  for (const file of files) {
    for (const declaration of file.parsed.declarations) {
      if (declaration.fqn === method.className || !ancestorsOf(declaration, all).has(method.className)) {
        continue;
      }

      const declared = file.parsed.methods.find(
        (candidate) => candidate.className === declaration.fqn && candidate.name === method.name && !candidate.isAbstract,
      );

      if (declared) {
        found.push({ file, method: declared, className: declaration.fqn });
      }
    }
  }

  return found.sort((first, second) => first.className.localeCompare(second.className));
}

/** How many classes end up carrying a body for each of these methods of `className`. */
export async function implementationCounts(
  className: string,
  names: string[],
): Promise<Map<string, number>> {
  const files = await getPhpIndex();
  const all = new Map(
    files.flatMap((file) => file.parsed.declarations).map((declaration) => [declaration.fqn, declaration]),
  );
  const counts = new Map(names.map((name) => [name, 0]));

  for (const file of files) {
    for (const declaration of file.parsed.declarations) {
      if (declaration.fqn === className || !ancestorsOf(declaration, all).has(className)) {
        continue;
      }

      for (const method of file.parsed.methods) {
        const known = counts.get(method.name);

        if (method.className !== declaration.fqn || method.isAbstract || known === undefined) {
          continue;
        }

        counts.set(method.name, known + 1);
      }
    }
  }

  return counts;
}

/**
 * Lists the classes that answer a call to an abstract or interface method.
 *
 * Going the other way — from the contract to the code that honours it — is how you read an
 * interface, and there is no way to do it from the editor otherwise.
 */
export async function findImplementations(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const location = await methodAtCursor(file, editor.document.offsetAt(editor.selection.active));

  if (!location) {
    vscode.window.showWarningMessage('Place the cursor on a method name.');
    return;
  }

  const implementations = await withProgress(`Looking for implementations of ${location.method.name}()…`, () =>
    implementationsOf(location.method),
  );

  if (implementations.length === 0) {
    vscode.window.showInformationMessage(`Nothing implements ${location.method.name}().`);
    return;
  }

  await showUsagesView({
    subject: `${location.method.name}()`,
    unit: 'implementations',
    groups: [
      {
        label: 'Implemented by',
        entries: implementations.map(({ file, method, className }) => ({
          uri: file.uri,
          range: file.mapper.range(method.nameStart, method.nameEnd),
          label: className.split('\\').pop() ?? className,
          description: className,
        })),
      },
    ],
  });
}
