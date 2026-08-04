import * as vscode from 'vscode';
import { astOf } from './php/nodeIndex';
import { getPhpIndex, indexedFile, type IndexedFile } from './php/phpIndex';
import type { MethodDeclaration } from './php/members';

/** A hint to draw: the name of the parameter an argument is passed to. */
export interface ParameterHint {
  offset: number;
  label: string;
}

/** Arguments that already say which parameter they fill get no hint. */
function isSelfExplanatory(argument: any, parameterName: string): boolean {
  if (argument?.kind === 'variable' && typeof argument.name === 'string') {
    return argument.name.toLowerCase() === parameterName.toLowerCase();
  }

  // A named argument carries the parameter name in the source already.
  return argument?.kind === 'namedargument' || argument?.name?.kind === 'identifier';
}

/** The call target written in the source, when it can be named without inferring a type. */
function calleeOf(node: any, className: string): { type: string; method: string } | null {
  if (node.kind === 'new' && typeof node.what?.name === 'string') {
    return { type: node.what.name, method: '__construct' };
  }

  if (node.kind !== 'call') {
    return null;
  }

  const target = node.what;

  if (target?.kind === 'staticlookup' && typeof target.what?.name === 'string') {
    const name = target.offset?.name;
    return typeof name === 'string' ? { type: target.what.name, method: name } : null;
  }

  // `$this->…` is the one member call whose class is known without inference.
  if (target?.kind === 'propertylookup' && target.what?.kind === 'variable' && target.what.name === 'this') {
    const name = target.offset?.name;
    return typeof name === 'string' && className !== '' ? { type: className, method: name } : null;
  }

  return null;
}

function declarationFor(
  files: IndexedFile[],
  type: string,
  method: string,
): MethodDeclaration | null {
  const shortName = type.split('\\').pop();

  for (const file of files) {
    const found = file.parsed.methods.find(
      (candidate) =>
        candidate.name === method && (candidate.className.split('\\').pop() ?? '') === shortName,
    );

    if (found) {
      return found;
    }
  }

  return null;
}

/** Class the offset sits in, for the `$this->…` calls. */
function enclosingClassName(file: IndexedFile, offset: number): string {
  // `start`/`end` are the offsets of the short name; the body is what holds the calls.
  const declaration = file.parsed.declarations.find(
    (candidate) => candidate.bodyStart <= offset && candidate.bodyEnd >= offset,
  );

  return declaration?.name ?? '';
}

/**
 * Names the arguments of the calls whose target is written in the source — a constructor,
 * a static call, a call on `$this`. A call on a variable needs its type resolved, which is
 * too much work to redo for every call in the viewport.
 */
export function parameterHints(
  file: IndexedFile,
  files: IndexedFile[],
  from: number,
  to: number,
): ParameterHint[] {
  const ast = astOf(file.text);

  if (!ast) {
    return [];
  }

  const hints: ParameterHint[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    const isInView = node.loc && node.loc.start.offset >= from && node.loc.end.offset <= to;

    if (isInView && Array.isArray(node.arguments)) {
      const callee = calleeOf(node, enclosingClassName(file, node.loc.start.offset));
      const declaration = callee ? declarationFor(files, callee.type, callee.method) : null;

      (declaration?.params ?? []).forEach((parameter, index) => {
        const argument = node.arguments[index];

        if (argument?.loc && !isSelfExplanatory(argument, parameter.name)) {
          hints.push({ offset: argument.loc.start.offset, label: `${parameter.name}:` });
        }
      });
    }

    Object.keys(node).forEach((key) => key !== 'loc' && walk(node[key]));
  };

  walk(ast);

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
    const files = await getPhpIndex();

    if (token.isCancellationRequested) {
      return [];
    }

    return parameterHints(file, files, document.offsetAt(range.start), document.offsetAt(range.end)).map(
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
