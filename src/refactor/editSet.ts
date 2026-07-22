/** A replacement expressed in file offsets, before it becomes a `vscode.TextEdit`. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Collects edits for one file while refusing overlaps. The same span can be reached twice —
 * an import line is both an import and a literal-looking name — and VS Code rejects the
 * whole workspace edit when two of them overlap.
 */
export class EditSet {
  private readonly edits: TextEdit[] = [];

  add(edit: TextEdit): void {
    if (this.overlaps(edit)) {
      return;
    }

    this.edits.push(edit);
  }

  all(): TextEdit[] {
    return [...this.edits].sort((first, second) => first.start - second.start);
  }

  private overlaps(edit: TextEdit): boolean {
    return this.edits.some((existing) => {
      if (existing.start === existing.end || edit.start === edit.end) {
        return existing.start === edit.start && existing.end === edit.end;
      }

      return edit.start < existing.end && existing.start < edit.end;
    });
  }
}
