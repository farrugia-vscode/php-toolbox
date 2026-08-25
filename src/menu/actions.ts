import * as vscode from 'vscode';
import { descendantSearch } from '../usages';
import type { CursorContext } from './context';
import type { UsagesSearch } from '../findUsages';

// Going somewhere is not editing, and VS Code standardises no kind for it. An empty kind
// would do, but nothing tells it apart from a provider that forgot to say — and the Alt+Enter
// menu reads the kind to know these belong at the top, above the refactorings.
export const NAVIGATE = vscode.CodeActionKind.Empty.append('navigate');
const EXTRACT = vscode.CodeActionKind.RefactorExtract;
const INLINE = vscode.CodeActionKind.RefactorInline;
const REWRITE = vscode.CodeActionKind.RefactorRewrite;
const MOVE = vscode.CodeActionKind.RefactorMove;

/** One entry of the menu: what it says, what it runs, and where it belongs. */
export interface Rule {
  title: string | ((context: CursorContext) => string);
  command: string;
  kind: vscode.CodeActionKind;
  when: (context: CursorContext) => boolean;
  args?: (context: CursorContext) => unknown[];
}

const onTypeName = (context: CursorContext): boolean => context.type !== null;
const onMemberName = (context: CursorContext): boolean => context.member !== null;
const onMethodName = (context: CursorContext): boolean => context.member?.kind === 'method';
const onMemberUsage = (context: CursorContext): boolean =>
  context.member === null && context.isOnMemberUsage;
const onLocal = (context: CursorContext): boolean =>
  context.member === null && !context.isOnMemberUsage && context.isOnLocal;

/**
 * The search a type asks for: an interface is looked up for its implementations. A type
 * nothing can be built on is looked up for everything, as narrowing would hide the answer.
 */
function searchForType(context: CursorContext): { title: string; search: UsagesSearch } {
  const declaration = context.type;
  const isInherited =
    declaration?.kind === 'interface' || declaration?.kind === 'trait' || declaration?.isAbstract === true;

  if (!declaration || !isInherited) {
    return { title: 'Find usages', search: {} };
  }

  const { categories, label } = descendantSearch(declaration.kind);

  return { title: `Find ${label}`, search: { categories, label } };
}

/**
 * The whole menu, in the order it reads: what the cursor points at first, then what can be
 * pulled out of it, folded into it, rewritten, and finally moved elsewhere. Adding an
 * action means adding a line here — never a second place deciding where the cursor is.
 */
export const RULES: Rule[] = [
  // Navigate
  {
    title: (context) => searchForType(context).title,
    command: 'phpToolbox.findUsages',
    kind: NAVIGATE,
    when: onTypeName,
    args: (context) => [searchForType(context).search],
  },
  {
    title: 'Find all usages',
    command: 'phpToolbox.findUsages',
    kind: NAVIGATE,
    // Only worth a second entry when the first one narrowed the search.
    when: (context) => onTypeName(context) && searchForType(context).search.categories !== undefined,
  },
  {
    title: 'Find usages',
    command: 'phpToolbox.findMemberUsages',
    kind: NAVIGATE,
    when: (context) => onMemberName(context) || onMemberUsage(context),
  },
  {
    title: 'Find implementations',
    command: 'phpToolbox.findImplementations',
    kind: NAVIGATE,
    when: (context) => context.member?.kind === 'method' && context.member.isAbstract,
  },

  {
    title: 'Go to test',
    command: 'phpToolbox.goToTest',
    kind: NAVIGATE,
    when: onTypeName,
  },

  // Extract
  {
    title: 'Extract interface…',
    command: 'phpToolbox.extractInterface',
    kind: EXTRACT,
    when: (context) => context.type?.kind === 'class' && !context.type.isAbstract,
  },
  {
    title: 'Extract trait…',
    command: 'phpToolbox.extractTrait',
    kind: EXTRACT,
    when: (context) => context.type?.kind === 'class' || context.type?.kind === 'trait',
  },

  // Inline
  {
    title: 'Inline method',
    command: 'phpToolbox.inlineMethod',
    kind: INLINE,
    when: (context) => onMethodName(context) || onMemberUsage(context),
  },

  // Rewrite
  {
    title: 'Rename…',
    command: 'phpToolbox.renameType',
    kind: REWRITE,
    when: onTypeName,
  },
  {
    title: 'Rename…',
    command: 'phpToolbox.renameMember',
    kind: REWRITE,
    when: (context) => onMemberName(context) || onMemberUsage(context),
  },
  {
    title: 'Rename…',
    command: 'phpToolbox.renameLocal',
    kind: REWRITE,
    when: onLocal,
  },
  {
    title: 'Change signature…',
    command: 'phpToolbox.changeSignature',
    kind: REWRITE,
    when: (context) => onMethodName(context) || onMemberUsage(context),
  },
  {
    title: 'Generate constructor…',
    command: 'phpToolbox.generateConstructor',
    kind: REWRITE,
    when: (context) => context.type?.kind === 'class' || context.type?.kind === 'trait',
  },
  {
    title: 'Implement missing methods…',
    command: 'phpToolbox.implementMissing',
    kind: REWRITE,
    when: (context) =>
      context.type !== null && (context.type.parent !== null || context.type.interfaces.length > 0),
  },
  {
    title: 'Override method…',
    command: 'phpToolbox.overrideMethod',
    kind: REWRITE,
    // Only what is inherited can be overridden, and an interface brings no body to replace.
    when: (context) =>
      context.type !== null && (context.type.parent !== null || context.type.traits.length > 0),
  },
  {
    title: 'Sort members',
    command: 'phpToolbox.sortMembers',
    kind: REWRITE,
    when: (context) => context.type !== null && context.type.kind !== 'interface',
  },
  {
    title: 'Safe delete',
    command: 'phpToolbox.safeDelete',
    kind: REWRITE,
    when: (context) => onTypeName(context) || onMemberName(context),
  },

  // Move
  {
    title: 'Move class…',
    command: 'phpToolbox.moveClass',
    kind: MOVE,
    when: onTypeName,
  },
  {
    title: 'Copy class…',
    command: 'phpToolbox.copyClass',
    kind: MOVE,
    when: onTypeName,
  },
  {
    title: 'Move method to another class…',
    command: 'phpToolbox.moveMethod',
    kind: MOVE,
    // From the declaration only: a call site names the method but holds nothing to move.
    when: onMethodName,
  },
  {
    title: 'Pull member up…',
    command: 'phpToolbox.pullMemberUp',
    kind: MOVE,
    when: onMemberName,
  },
  {
    title: 'Push member down…',
    command: 'phpToolbox.pushMemberDown',
    kind: MOVE,
    when: onMemberName,
  },
];

export function actionsFor(context: CursorContext): vscode.CodeAction[] {
  return RULES.filter((rule) => rule.when(context)).map((rule) => {
    const title = typeof rule.title === 'string' ? rule.title : rule.title(context);
    const created = new vscode.CodeAction(title, rule.kind);

    created.command = { command: rule.command, title, arguments: rule.args?.(context) ?? [] };

    return created;
  });
}
