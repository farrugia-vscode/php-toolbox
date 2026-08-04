/** The source a node was parsed from. */
export function textOf(text: string, node: any): string {
  return text.slice(node.loc.start.offset, node.loc.end.offset);
}
