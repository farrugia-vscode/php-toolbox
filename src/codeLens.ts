import * as vscode from 'vscode';
import { implementationCounts } from './findImplementations';
import { indexedFile, type IndexedFile } from './php/phpIndex';
import type { Declaration } from './php/parser';
import { accessKey, countMemberUsages, type MemberRef } from './refactor/callSites';
import { descendantSearch, findUsages, referenceCategories, type Usage } from './usages';
import { memberAliases, onDidChangeProviders } from './api';
import { plural } from './usagesView';

function countIn(usages: Usage[], categories: string[]): number {
  return usages.filter((usage) => categories.includes(usage.category)).length;
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

/** True for a method the code reaches as a property, which is read and written rather than called. */
function isServedAsProperty(member: MemberRef): boolean {
  return (member.aliases ?? []).some((alias) => alias.kind === 'property');
}

/** How a count reads for the kind of member it counts. */
function countLabel(member: MemberRef, count: { read: number; written: number }): string {
  if (member.kind === 'method' && !isServedAsProperty(member)) {
    return plural(count.read, 'calls');
  }

  if (member.kind === 'constant') {
    return plural(count.read, 'usages');
  }

  return `${plural(count.read, 'reads')}, ${plural(count.written, 'writes')}`;
}

/**
 * Every member of the file worth counting, private ones included: what a private method
 * costs to change is exactly the question the file cannot answer at a glance.
 *
 * A constructor is left out. It is not called by name, and its promoted parameters
 * already carry a lens of their own on that very line.
 */
function countableMembers(file: IndexedFile): Array<MemberRef & { nameStart: number }> {
  return [
    ...file.parsed.properties
      .filter((property) => property.className.length > 0)
      .map((property) => ({
        kind: 'property' as const,
        name: property.name,
        className: property.className,
        nameStart: property.nameStart,
      })),
    ...file.parsed.methods
      .filter((method) => method.className.length > 0 && method.name !== '__construct')
      .map((method) => ({
        kind: 'method' as const,
        name: method.name,
        className: method.className,
        nameStart: method.nameStart,
        aliases: memberAliases({
          kind: 'method',
          name: method.name,
          className: method.className,
          returnType: method.returnType,
        }),
      })),
    ...file.parsed.constants
      .filter((constant) => constant.className.length > 0)
      .map((constant) => ({
        kind: 'constant' as const,
        name: constant.name,
        className: constant.className,
        nameStart: constant.nameStart,
      })),
  ];
}

/**
 * What a member is subjected to, which is the question a declaration raises: a value read
 * everywhere and written in one place is a very different thing from one written from
 * anywhere. A promoted parameter counts the arguments that build it as its writes.
 */
async function memberLenses(file: IndexedFile, uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const members = countableMembers(file);

  if (members.length === 0) {
    return [];
  }

  const counts = await countMemberUsages(members);

  return members.flatMap((member) => {
    const count = counts.get(accessKey(member));

    if (!count || count.read + count.written === 0) {
      return [];
    }

    return [
      lens(
        file.mapper.at(member.nameStart),
        countLabel(member, count),
        'phpToolbox.findMemberUsages',
        uri,
      ),
    ];
  });
}

const changed = new vscode.EventEmitter<void>();

onDidChangeProviders(() => changed.fire());

/**
 * The one switch of every usages lens, this extension's and those of the extensions that
 * follow it. A setting rather than a state of its own, so that a single value answers for
 * all of them and any extension can read it.
 */
export const USAGES_LENS_SETTING = 'phpToolbox.usagesLens.enabled';

export function isUsagesLensEnabled(): boolean {
  return vscode.workspace.getConfiguration().get(USAGES_LENS_SETTING, false);
}

/** Redraws the lenses when the switch moves, from the command or from the settings. */
export function watchUsagesLensSetting(): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(USAGES_LENS_SETTING)) {
      changed.fire();
    }
  });
}

/**
 * Turns every usages lens off and on.
 *
 * The counts answer a question that is only asked now and then; the rest of the time they
 * are a line of grey above every declaration, which is exactly what reading code does not need.
 */
export async function toggleCodeLens(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration();
  const enabled = !isUsagesLensEnabled();

  await configuration.update(USAGES_LENS_SETTING, enabled, settingTarget(configuration));

  vscode.window.setStatusBarMessage(enabled ? 'Usages lenses shown' : 'Usages lenses hidden', 2000);
}

/** Where the switch is written: the place that currently decides its value, or the user settings. */
function settingTarget(configuration: vscode.WorkspaceConfiguration): vscode.ConfigurationTarget {
  const inspected = configuration.inspect<boolean>(USAGES_LENS_SETTING);

  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }

  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }

  return vscode.ConfigurationTarget.Global;
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
    if (!isUsagesLensEnabled()) {
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
      const references = countIn(usages, referenceCategories());
      const built = countIn(usages, descendants.categories);

      lenses.push(
        lens(at, plural(references, 'references'), 'phpToolbox.findUsages', document.uri, [
          { categories: referenceCategories(), label: 'references' },
        ]),
      );

      if (built > 0) {
        lenses.push(
          lens(at, plural(built, descendants.label), 'phpToolbox.findUsages', document.uri, [descendants]),
        );
      }

      lenses.push(...(await methodLenses(file, declaration, document.uri)));
    }

    lenses.push(...(await memberLenses(file, document.uri)));

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
