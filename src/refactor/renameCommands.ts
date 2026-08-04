import * as vscode from 'vscode';
import { scopesFor } from '../php/documentAnalysis';
import { indexedFile } from '../php/phpIndex';
import { activeTarget, applyPlan, askName } from './apply';
import { localAt, namesTakenAround, planRenameLocal } from './renameLocal';
import { memberAtCursor, renameMember } from './renameMember';
import { renameType } from './renameProvider';

export async function renameLocal(): Promise<void> {
  const target = activeTarget();

  if (!target) {
    return;
  }

  const offset = target.selection.start;
  const local = localAt(scopesFor(target.document), target.text, offset);

  if (!local) {
    vscode.window.showWarningMessage('Place the cursor on a local variable or a parameter.');
    return;
  }

  const newName = await askName(
    `Rename $${local.name}`,
    local.name,
    'Renames it everywhere this function mentions it',
    namesTakenAround(local),
  );

  if (!newName || newName === local.name) {
    return;
  }

  await applyPlan(target.document, planRenameLocal(target.text, offset, newName));
}

/**
 * One shortcut for every rename, the way Shift+F6 works in PhpStorm: what gets renamed is
 * decided by what the cursor is on, not by which command was picked from the palette.
 *
 * Members come first, so a promoted constructor parameter is renamed as the property it
 * declares — with its reads across the project — rather than as a parameter of one function.
 * Types come last, because that is the branch already able to say what to aim at when the
 * cursor is on nothing renameable.
 */
export async function rename(): Promise<void> {
  const target = activeTarget();

  if (!target) {
    return;
  }

  const offset = target.selection.start;
  const file = indexedFile(target.document.uri, target.text);

  if (await memberAtCursor(file, offset)) {
    await renameMember();
    return;
  }

  if (localAt(scopesFor(target.document), target.text, offset)) {
    await renameLocal();
    return;
  }

  await renameType();
}
