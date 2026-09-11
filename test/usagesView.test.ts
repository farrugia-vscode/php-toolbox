import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';
import { createdTreeViews, executedCommands, Position, Range, TreeItemCollapsibleState, Uri } from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { registerUsagesView, showUsagesView } = await import('../src/usagesView');

const at = (path: string, line: number) => ({
  uri: Uri.parse(`file:///p/${path}`) as never,
  range: new Range(new Position(line, 4), new Position(line, 12)) as never,
});

registerUsagesView();
const provider = createdTreeViews[0].treeDataProvider;

async function listOrders() {
  await showUsagesView({
    subject: 'Order',
    unit: 'references',
    groups: [
      { label: 'Instantiated', entries: [{ ...at('app/Checkout.php', 30), label: 'new Order()' }, { ...at('app/Checkout.php', 12), label: '$order = new Order();' }] },
      { label: 'Extended by', entries: [] },
      { label: 'Injected or type hinted', entries: [{ ...at('app/Ship.php', 8), label: 'public function ship(Order $order)', description: 'app/Ship.php' }] },
    ],
  });
}

describe('the usages panel', () => {
  test('lists heading, then file, then line, folding nothing and skipping empty headings', async () => {
    await listOrders();

    const groups = provider.getChildren();
    const files = provider.getChildren(groups[0]);
    const lines = provider.getChildren(files[0]);

    expect(groups.map((group: any) => provider.getTreeItem(group).label)).toEqual(['Instantiated', 'Injected or type hinted']);
    expect(provider.getTreeItem(groups[0]).description).toBe('2');
    expect(provider.getTreeItem(groups[0]).collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(files.map((file: any) => provider.getTreeItem(file).label)).toEqual(['Checkout.php']);
    expect(provider.getTreeItem(files[0]).description).toBe('app');
    expect(lines.map((line: any) => provider.getTreeItem(line).label)).toEqual(['$order = new Order();', 'new Order()']);
  });

  test('opens the line it stands for, and says where it is', async () => {
    await listOrders();

    const [group] = provider.getChildren();
    const [file] = provider.getChildren(group);
    const item = provider.getTreeItem(provider.getChildren(file)[0]);

    expect(item.description).toBe('line 13');
    expect(item.command?.command).toBe('vscode.open');
    expect(item.command?.arguments?.[1]).toEqual({ selection: at('app/Checkout.php', 12).range });
  });

  test('numbers each listing afresh so a new one opens unfolded, and brings the panel up', async () => {
    await listOrders();
    const first = provider.getTreeItem(provider.getChildren()[0]).id;

    await listOrders();
    const second = provider.getTreeItem(provider.getChildren()[0]).id;

    expect(first).not.toBe(second);
    expect(createdTreeViews[0].description).toBe('Order: 3 references');
    expect(executedCommands.at(-1)).toEqual({ command: 'phpToolbox.usages.focus', arguments: [] });
  });
});
