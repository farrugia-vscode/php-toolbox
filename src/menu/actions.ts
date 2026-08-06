import * as vscode from 'vscode';
import { IMPLEMENTATION_CATEGORIES, TRAIT_USER_CATEGORIES } from '../usages';
import type { CursorContext } from './context';
import type { UsagesSearch } from '../findUsages';

const NAVIGATE = vscode.CodeActionKind.Empty;
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

/** The search a type asks for: an interface is looked up for its implementations. */
function searchForType(context: CursorContext): { title: string; search: UsagesSearch } {
  const declaration = context.type;

  if (declaration?.kind === 'interface' || declaration?.isAbstract) {
    return {
      title: 'Find implementations',
      search: { categories: IMPLEMENTATION_CATEGORIES, label: 'implementations' },
    };
  }

  if (declaration?.kind === 'trait') {
    return { title: 'Find trait users', search: { categories: TRAIT_USER_CATEGORIES, label: 'trait users' } };
  }

  return { title: 'Find usages', search: {} };
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

  // Extract
  {
    title: 'Extract interface…',
    command: 'phpToolbox.extractInterface',
    kind: EXTRACT,
    when: (context) => context.type?.kind === 'class' && !context.type.isAbstract,
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
  {
    title: 'Copy class…',
    command: 'phpToolbox.copyClass',
    kind: MOVE,
    when: onTypeName,
  },

    return created;
  });
}
