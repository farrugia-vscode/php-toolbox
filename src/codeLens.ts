import * as vscode from 'vscode';
import { implementationCounts } from './findImplementations';
import { indexedFile, type IndexedFile } from './php/phpIndex';
import type { Declaration } from './php/parser';
import { accessKey, countPropertyAccesses } from './refactor/callSites';
import { descendantSearch, findUsages, REFERENCE_CATEGORIES, type Usage } from './usages';

function countIn(usages: Usage[], categories: string[]): number {
  return usages.filter((usage) => categories.includes(usage.category)).length;
}

/** "1 reference", "8 references": a lens reads as a sentence, not as a count. */
function plural(total: number, word: string): string {
  return `${total} ${total === 1 ? word.replace(/s$/, '') : word}`;
}

function lens(
  position: vscode.Position,
  title: string,
  command: string,
  uri: vscode.Uri,
  args: unknown[] = [],
): vscode.CodeLens {
  return new vscode.CodeLens(new vscode.Range(position, position), {
    title,
    command: 'phpToolbox.revealAt',
    arguments: [uri, position, command, args],
  });
}

/**
 * A contract is read from the other end too: from the method that promises something to
 * the classes that answer for it. Only what has no body of its own can be answered.
 */
async function methodLenses(
  file: IndexedFile,
  declaration: Declaration,
  uri: vscode.Uri,
): Promise<vscode.CodeLens[]> {
  const methods = file.parsed.methods.filter(
    (method) => method.className === declaration.fqn && method.isAbstract,
  );

  if (methods.length === 0) {
    return [];
  }

  const counts = await implementationCounts(
    declaration.fqn,
    methods.map((method) => method.name),
  );

  return methods
    .filter((method) => (counts.get(method.name) ?? 0) > 0)
    .map((method) =>
      lens(
        file.mapper.at(method.nameStart),
        plural(counts.get(method.name) ?? 0, 'implementations'),
        'phpToolbox.findImplementations',
        uri,
      ),
    );
}

/**
 * What a property is subjected to, which is the question a field raises: a value read
 * everywhere and written in one place is a very different thing from one written from
 * anywhere. A promoted parameter counts the arguments that build it as its writes.
 */
async function propertyLenses(file: IndexedFile, uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const properties = file.parsed.properties.filter((property) => property.className.length > 0);

  if (properties.length === 0 || !vscode.workspace.getConfiguration('phpToolbox').get('propertyAccessLens.enabled', true)) {
    return [];
  }

  const counts = await countPropertyAccesses(
    properties.map((property) => ({ kind: 'property' as const, name: property.name, className: property.className })),
  );

  return properties.flatMap((property) => {
    const count = counts.get(accessKey(property));

    if (!count || count.read + count.written === 0) {
      return [];
    }

    return [
      lens(
        file.mapper.at(property.nameStart),
        `${plural(count.read, 'reads')}, ${plural(count.written, 'writes')}`,
        'phpToolbox.findMemberUsages',
        uri,
      ),
    ];
  });
}

const changed = new vscode.EventEmitter<void>();

let hiddenState: vscode.Memento | null = null;
let isHidden = false;

const HIDDEN_KEY = 'codeLens.isHidden';

/** Remembers across reloads whether the lenses were left off. */
export function initCodeLens(memento: vscode.Memento): void {
  hiddenState = memento;
  isHidden = memento.get(HIDDEN_KEY, false);
}

/**
 * Turns every lens of this extension off and on.
 *
 * The counts answer a question that is only asked now and then; the rest of the time they
 * are a line of grey above every declaration, which is exactly what reading code does not need.
 */
export function toggleCodeLens(): void {
  isHidden = !isHidden;
  hiddenState?.update(HIDDEN_KEY, isHidden);
  changed.fire();
  vscode.window.setStatusBarMessage(isHidden ? 'PHP lenses hidden' : 'PHP lenses shown', 2000);
}

/**
 * Puts the two numbers worth knowing above a type: how much of the project names it, and
 * how much of it is built on top. Both are counted from the very listing the lens opens,
 * so the number and the list it leads to can never disagree.
 */
export class PhpCodeLensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses = changed.event;

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (isHidden) {
      return [];
    }

    const file = indexedFile(document.uri, document.getText());
    const lenses: vscode.CodeLens[] = [];

    for (const declaration of file.parsed.declarations) {
      const usages = await findUsages(declaration.name, document.uri, token);

      if (token.isCancellationRequested) {
        return [];
      }

      const at = file.mapper.at(declaration.start);
      const descendants = descendantSearch(declaration.kind);
      const references = countIn(usages, REFERENCE_CATEGORIES);
      const built = countIn(usages, descendants.categories);

      lenses.push(
        lens(at, plural(references, 'references'), 'phpToolbox.findUsages', document.uri, [
          { categories: REFERENCE_CATEGORIES, label: 'references' },
        ]),
      );

      if (built > 0) {
        lenses.push(
          lens(at, plural(built, descendants.label), 'phpToolbox.findUsages', document.uri, [descendants]),
        );
      }

      lenses.push(...(await methodLenses(file, declaration, document.uri)));
    }

    lenses.push(...(await propertyLenses(file, document.uri)));

    return lenses;
  }
}

/**
 * A code lens fires with no editor selection of its own, so the command it stands for has
 * to be run with the cursor placed on the declaration first.
 */
export async function revealAt(
  uri: vscode.Uri,
  position: vscode.Position,
  command: string,
  args: unknown[] = [],
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);

  editor.selection = new vscode.Selection(position, position);

  await vscode.commands.executeCommand(command, ...args);
}
