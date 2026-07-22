import * as vscode from 'vscode';

/**
 * Converts byte offsets — what the PHP parser reports — into editor positions.
 * Line starts are computed once per file: doing it per offset turns a rename touching
 * a few hundred references into a quadratic scan of the whole workspace.
 */
export class PositionMapper {
  private readonly lineStarts: number[];

  constructor(text: string) {
    this.lineStarts = [0];
    for (let offset = text.indexOf('\n'); offset !== -1; offset = text.indexOf('\n', offset + 1)) {
      this.lineStarts.push(offset + 1);
    }
  }

  at(offset: number): vscode.Position {
    let low = 0;
    let high = this.lineStarts.length - 1;

    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    return new vscode.Position(low, offset - this.lineStarts[low]);
  }

  range(start: number, end: number): vscode.Range {
    return new vscode.Range(this.at(start), this.at(end));
  }
}
