/** Splitting a fully qualified name, without needing the editor API to do it. */

export function shortNameOf(fqn: string): string {
  return fqn.split('\\').pop() ?? fqn;
}

export function namespaceOf(fqn: string): string {
  return fqn.split('\\').slice(0, -1).join('\\');
}
