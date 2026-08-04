import * as vscode from 'vscode';
import type { Member } from './types';
import { findMemberAccess } from './php/receiverChain';
import { isQueryingServer, membersOf, receiverClassAt } from './mixinResolution';

/** The member the cursor sits on, resolved through the mixins the server ignores. */
async function memberAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<Member | null> {
  // Our own resolution asks the server for hovers and definitions; answering those calls
  // in turn would loop.
  if (isQueryingServer()) {
    return null;
  }

  const access = findMemberAccess(document.getText(), document.offsetAt(position));

  if (!access) {
    return null;
  }

  const receiver = await receiverClassAt(document, access.start);

  if (!receiver) {
    return null;
  }

  const members = await membersOf(receiver.target);

  return members.get(`$${access.name}`) ?? members.get(access.name) ?? null;
}

/**
 * Shows the type of a member the server left untyped. VS Code stacks hovers rather than
 * replacing them, so this one sits next to whatever the server had to say.
 */
export class MixinHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const member = await memberAt(document, position);

    if (!member || member.detail === '' || token.isCancellationRequested) {
      return undefined;
    }

    const name = member.name.replace(/^\$/, '');
    const origin = member.className.split('\\').pop();
    const markdown = new vscode.MarkdownString();
    markdown.appendCodeblock(`${member.detail} $${name}`, 'php');
    markdown.appendMarkdown(`_via_ \`@mixin ${origin}\``);

    return new vscode.Hover(markdown);
  }
}

/**
 * Sends a ctrl+click on such a member to where it is declared — for a model attribute,
 * the `@property` line ide-helper wrote.
 */
export class MixinDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location | undefined> {
    const member = await memberAt(document, position);

    if (!member || token.isCancellationRequested) {
      return undefined;
    }

    return new vscode.Location(member.uri, member.range);
  }
}
