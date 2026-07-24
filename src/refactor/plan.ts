import type { TextEdit } from './editSet';

/** What a refactoring produces: edits to apply, and a line to report once applied. */
export interface Plan {
  edits: TextEdit[];
  summary: string;
  /** Something the user should confirm before the edits are applied. */
  warning?: string;
}

/** A refactoring either has a plan, or a reason it refuses to touch the code. */
export type Planned<T extends Plan = Plan> = T | { error: string };

export function isRefused<T extends Plan>(result: Planned<T>): result is { error: string } {
  return 'error' in result;
}

/** Applies offset edits to a string, last first, so earlier offsets stay valid. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  return [...edits]
    .sort((first, second) => second.start - first.start)
    .reduce((current, edit) => current.slice(0, edit.start) + edit.text + current.slice(edit.end), text);
}
