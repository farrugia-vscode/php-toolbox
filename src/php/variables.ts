import type { FunctionScope } from './scopes';

/**
 * Native functions that write through an argument. Without them, code as ordinary as
 * `preg_match($pattern, $subject, $matches)` looks like it never defines `$matches`.
 */
const BY_REFERENCE_ARGUMENTS: Record<string, number[]> = {
  preg_match: [2], preg_match_all: [2], sscanf: [2, 3, 4, 5], settype: [0], similar_text: [2],
  sort: [0], rsort: [0], usort: [0], uasort: [0], uksort: [0], ksort: [0], krsort: [0],
  asort: [0], arsort: [0], shuffle: [0], array_push: [0], array_pop: [0], array_shift: [0],
  array_unshift: [0], array_splice: [0], array_walk: [0], array_multisort: [0], extract: [0],
  end: [0], reset: [0], next: [0], prev: [0], str_replace: [3], preg_replace: [4],
};

export function addUse(scope: FunctionScope, node: any, isWrite: boolean): void {
  if (typeof node?.name !== 'string' || !node.loc) {
    return;
  }

  if (node.name === 'this') {
    scope.usesThis = true;
  }

  scope.uses.push({
    name: node.name,
    start: node.loc.start.offset,
    end: node.loc.end.offset,
    isWrite,
  });
}

/** Marks every variable an assignment target writes to, including destructuring. */
export function collectWrites(target: any, scope: FunctionScope, walk: (node: any) => void): void {
  if (!target || typeof target !== 'object') {
    return;
  }

  if (target.kind === 'variable') {
    addUse(scope, target, true);
    return;
  }

  if (target.kind === 'list' || target.kind === 'array') {
    (target.items ?? []).forEach((item: any) => collectWrites(item?.value ?? item, scope, walk));
    return;
  }

  // `$rows[] = …` and `$this->items[] = …` read the container and change it: both matter.
  if (target.kind === 'offsetlookup' || target.kind === 'propertylookup' || target.kind === 'staticlookup') {
    collectWrites(target.what, scope, walk);
    walk(target.offset);
    return;
  }

  walk(target);
}

/** Arguments a native function writes back into, so the caller keeps seeing a defined variable. */
export function collectCallWrites(node: any, scope: FunctionScope, recurse: (child: any) => void): void {
  const name = node.what?.name;
  const byReference = typeof name === 'string' ? BY_REFERENCE_ARGUMENTS[name.toLowerCase()] ?? [] : [];

  recurse(node.what);

  (node.arguments ?? []).forEach((argument: any, index: number) => {
    if (byReference.includes(index) && argument?.kind === 'variable') {
      addUse(scope, argument, true);
      return;
    }

    recurse(argument);
  });
}

