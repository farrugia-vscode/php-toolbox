import * as vscode from 'vscode';
import { activeTarget, applyPlan, askName } from './apply';
import { planExtractMethod } from './extractMethod';
import { planExtractExpression, suggestName, targetExpression, type ExtractTarget } from './extractExpression';
import { analyzeScopes, scopeAt } from '../php/scopes';
import { isRefused } from './plan';

/** Name no one writes, used to check a refactoring is possible before asking for a real one. */
const PROBE = '__phpToolboxProbe';

const TITLES: Record<ExtractTarget, string> = {
  variable: 'Extract variable',
  constant: 'Extract constant',
  property: 'Extract property',
};

export async function extractMethod(): Promise<void> {
  const target = activeTarget();

  if (!target) {
    return;
  }

  const probe = planExtractMethod(target.text, target.selection, PROBE);

  if (isRefused(probe)) {
    vscode.window.showWarningMessage(probe.error);
    return;
  }

  const scopes = analyzeScopes(target.text);
  const scope = scopeAt(scopes, target.selection.start, target.selection.end);
  const siblings = scopes.functions
    .filter((candidate) => candidate.kind === 'method' && candidate.className === scope?.className)
    .map((candidate) => candidate.name);
  const name = await askName('Extract method', 'extracted', 'Name of the new private method', siblings);

  if (!name) {
    return;
  }

  await applyPlan(target.document, planExtractMethod(target.text, target.selection, name));
}

/**
 * Extracts the selected expression. The number of identical occurrences decides whether the
 * user is asked about them at all: with a single one there is nothing to decide.
 */
export async function extractExpression(kind: ExtractTarget, isReplacingAll = false): Promise<void> {
  const target = activeTarget();

  if (!target) {
    return;
  }

  const scopes = analyzeScopes(target.text);
  const expression = targetExpression(target.text, target.selection, scopes.expressions);

  if (!expression) {
    vscode.window.showWarningMessage('Select a complete expression.');
    return;
  }

  const code = target.text.slice(expression.start, expression.end);
  const probe = planExtractExpression(target.text, target.selection, PROBE, kind, { isReplacingAll });

  if (isRefused(probe)) {
    vscode.window.showWarningMessage(probe.error);
    return;
  }

  const scope = scopeAt(scopes, expression.start, expression.end);
  const taken =
    kind === 'variable' && scope ? [...new Set(scope.uses.map((use) => use.name))] : [];
  const name = await askName(
    TITLES[kind],
    suggestName(code, kind),
    code.replace(/\s+/g, ' ').slice(0, 80),
    taken,
  );

  if (!name) {
    return;
  }

  await applyPlan(
    target.document,
    planExtractExpression(target.text, target.selection, name, kind, { isReplacingAll }),
  );
}
