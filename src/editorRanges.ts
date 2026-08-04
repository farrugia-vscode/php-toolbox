import * as vscode from 'vscode';
import { foldingRanges, type FoldKind } from './php/folding';
import { enclosingSpans, stringContentAt } from './php/spans';

const FOLD_KINDS: Partial<Record<FoldKind, vscode.FoldingRangeKind>> = {
  comment: vscode.FoldingRangeKind.Comment,
  imports: vscode.FoldingRangeKind.Imports,
  region: vscode.FoldingRangeKind.Region,
};

/**
 * Folds a PHP file by what it declares rather than by how it is indented: a docblock, a
 * run of `use` lines and a heredoc all sit at the level of the code around them.
 */
export class PhpFoldingRangeProvider implements vscode.FoldingRangeProvider {
  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    return foldingRanges(document.getText()).map(
      (range) => new vscode.FoldingRange(range.startLine, range.endLine, FOLD_KINDS[range.kind]),
    );
  }
}

/**
 * Grows the selection one syntax step at a time — the string content, the string, the
 * argument, the call, the statement — instead of one word at a time.
 */
export class PhpSelectionRangeProvider implements vscode.SelectionRangeProvider {
  provideSelectionRanges(
    document: vscode.TextDocument,
    positions: vscode.Position[],
  ): vscode.SelectionRange[] {
    const text = document.getText();

    return positions.map((position) => {
      const offset = document.offsetAt(position);
      const content = stringContentAt(text, offset);
      const spans = enclosingSpans(text, offset);

      const ranges = [...(content ? [content] : []), ...spans].map(
        (span) => new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
      );

      // Built from the outside in: each range carries the wider one as its parent.
      return ranges.reduceRight<vscode.SelectionRange | undefined>(
        (parent, range) => new vscode.SelectionRange(range, parent),
        undefined,
      ) as vscode.SelectionRange;
    });
  }
}
