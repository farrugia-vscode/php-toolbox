/** The one shape a generated PHP file takes, so extracted types all look alike. */

export interface NewFile {
  namespace: string;
  /** Import lines, newline-terminated, as `importEdit` writes them. */
  imports: string;
  /** The declaration line: `interface Payable`, `trait Billable`. */
  header: string;
  /** What goes between the braces, already indented. */
  body: string;
}

export function phpFileContents({ namespace, imports, header, body }: NewFile): string {
  return [
    '<?php',
    '',
    `namespace ${namespace};`,
    '',
    imports,
    header,
    '{',
    body,
    '}',
    '',
  ]
    // Without imports there is nothing on that line, and two blank lines would be left.
    .filter((line, index) => line !== '' || index !== 4 || imports !== '')
    .join('\n');
}
