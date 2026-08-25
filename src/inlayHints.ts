import * as vscode from 'vscode';
import type { CallArgument, MethodDeclaration } from './php/members';
import { indexedFile, type IndexedFile } from './php/phpIndex';
import { declaredMethod, mentionResolution, projectOf, type Project } from './refactor/callSites';

/** A hint to draw: the name of the parameter an argument is passed to. */
export interface ParameterHint {
  offset: number;
  label: string;
}

/**
 * The name an argument already carries: `$total`, `now()` and `Carbon::now()` all say `now`
 * or `total` on their own. Anything else — a literal, an operation, a longer chain — has no
 * name of its own and returns null.
 */
function nameOf(written: string): string | null {
  const trailing = /(?:^|->|::|\$)(\w+)\s*(?:\(\s*\))?$/.exec(written.trim());

  return trailing ? trailing[1].toLowerCase() : null;
}

/** Arguments that already say which parameter they fill get no hint. */
function isSelfExplanatory(argument: CallArgument, parameterName: string, text: string): boolean {
  // A named argument carries the parameter name in the source already.
  if (argument.label !== null) {
    return true;
  }

  return nameOf(text.slice(argument.start, argument.end)) === parameterName.toLowerCase();
}

function hintsFor(declaration: MethodDeclaration, args: CallArgument[], text: string): ParameterHint[] {
  return declaration.params.flatMap((parameter, index) => {
    const argument = args[index];

    if (!argument || isSelfExplanatory(argument, parameter.name, text)) {
      return [];
    }

    return [{ offset: argument.start, label: `${parameter.name}:` }];
  });
}

/**
 * Names the arguments of the calls in view, whatever the call is written on.
 *
 * The receiver is resolved the way a rename resolves it, so a call on a typed variable is
 * named like a call on `$this`; what nothing can type stays bare rather than guessed at.
 */
export function parameterHints(
  file: IndexedFile,
  project: Project,
  from: number,
  to: number,
): ParameterHint[] {
  // The range is the viewport: a call straddling its edge is half visible, and hints that
  // come and go with the scroll are worse than hints that stay.
  const isInView = (start: number, end: number): boolean => end >= from && start <= to;
  const hints: ParameterHint[] = [];

  for (const call of file.parsed.calls) {
    if (!isInView(call.start, call.end)) {
      continue;
    }

    const resolution = mentionResolution(project, file, call);
    const declaration =
      resolution.kind === 'type' ? declaredMethod(project, resolution.fqn, call.name) : null;

    if (declaration) {
      hints.push(...hintsFor(declaration, call.args, file.text));
    }
  }

  for (const instantiation of file.parsed.instantiations) {
    const end = instantiation.args[instantiation.args.length - 1]?.end ?? instantiation.nameEnd;

    if (!instantiation.fqn || !isInView(instantiation.nameStart, end)) {
      continue;
    }

    const declaration = declaredMethod(project, instantiation.fqn, '__construct');

    if (declaration) {
      hints.push(...hintsFor(declaration, instantiation.args, file.text));
    }
  }

  return hints;
}

/** Draws the parameter names of a call, so a bare `true` at a call site says what it means. */
export class PhpInlayHintsProvider implements vscode.InlayHintsProvider {
  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlayHint[]> {
    const file = indexedFile(document.uri, document.getText());
    const project = await projectOf();

    if (token.isCancellationRequested) {
      return [];
    }

    return parameterHints(file, project, document.offsetAt(range.start), document.offsetAt(range.end)).map(
      (hint) => {
        const drawn = new vscode.InlayHint(
          document.positionAt(hint.offset),
          hint.label,
          vscode.InlayHintKind.Parameter,
        );
        drawn.paddingRight = true;

        return drawn;
      },
    );
  }
}
