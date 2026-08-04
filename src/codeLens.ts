import * as vscode from 'vscode';
import { getPhpIndex, indexedFile, type IndexedFile } from './php/phpIndex';
import type { Declaration } from './php/parser';

/** How many files a type is named in, and how many types are built from it. */
interface Counts {
  references: number;
  descendants: number;
}

function isDescendant(declaration: Declaration, fqn: string): boolean {
  return (
    declaration.parent === fqn ||
    declaration.interfaces.includes(fqn) ||
    declaration.traits.includes(fqn)
  );
}

function countsFor(files: IndexedFile[], fqn: string, own: vscode.Uri): Counts {
  let references = 0;
  let descendants = 0;

  for (const file of files) {
    const isOwnFile = file.uri.toString() === own.toString();

    references += file.parsed.references.filter(
      (reference) => reference.fqn === fqn && !isOwnFile,
    ).length;

    descendants += file.parsed.declarations.filter((declaration) =>
      isDescendant(declaration, fqn),
    ).length;
  }

  return { references, descendants };
}

function lens(
  range: vscode.Range,
  title: string,
  command: string,
  uri: vscode.Uri,
  position: vscode.Position,
): vscode.CodeLens {
  return new vscode.CodeLens(range, {
    title,
    command: 'phpToolbox.revealAt',
    arguments: [uri, position, command],
  });
}

/**
 * Puts the two numbers worth knowing above a type: how much of the project names it, and
 * how much of it is built on top. Both come from the parsed index, so no extra search runs.
 */
export class PhpCodeLensProvider implements vscode.CodeLensProvider {
  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const file = indexedFile(document.uri, document.getText());
    const files = await getPhpIndex();

    if (token.isCancellationRequested) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    for (const declaration of file.parsed.declarations) {
      const { references, descendants } = countsFor(files, declaration.fqn, document.uri);
      const at = file.mapper.at(declaration.start);
      const range = new vscode.Range(at, at);

      lenses.push(
        lens(
          range,
          references === 1 ? '1 reference' : `${references} references`,
          'phpToolbox.findUsages',
          document.uri,
          file.mapper.at(declaration.start),
        ),
      );

      if (descendants > 0) {
        const label = declaration.kind === 'interface' ? 'implementations' : 'subtypes';

        lenses.push(
          lens(
            range,
            `${descendants} ${descendants === 1 ? label.replace(/s$/, '') : label}`,
            'phpToolbox.findImplementations',
            document.uri,
            file.mapper.at(declaration.start),
          ),
        );
      }
    }

    return lenses;
  }
}

/**
 * A code lens fires with no editor selection of its own, so the command it stands for has
 * to be run with the cursor placed on the declaration first.
 */
export async function revealAt(uri: vscode.Uri, position: vscode.Position, command: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);

  editor.selection = new vscode.Selection(position, position);

  await vscode.commands.executeCommand(command);
}
