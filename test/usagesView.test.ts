import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';
import { documentLines, executedCommands, Position, postedMessages, Range, registeredWebviewViews, shownDocuments, StubWebviewView, Uri } from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { registerUsagesView, showUsagesView } = await import('../src/usagesView');

const at = (path: string, line: number, character = 4, endCharacter = 12) => ({
  uri: Uri.parse(`file:///p/${path}`) as never,
  range: new Range(new Position(line, character), new Position(line, endCharacter)) as never,
});

registerUsagesView(Uri.file('/ext') as never);
const view = new StubWebviewView();
registeredWebviewViews[0].provider.resolveWebviewView(view);

documentLines.set('file:///p/app/Checkout.php', Array.from({ length: 40 }, (_, line) => (line === 12 ? '    $order = new Order();' : '')));
documentLines.set('file:///p/app/Ship.php', Array.from({ length: 10 }, (_, line) => (line === 8 ? '    public function ship(Order $order)' : '')));

async function listOrders() {
  await showUsagesView({
    subject: 'Order',
    unit: 'references',
    groups: [
      { label: 'Instantiated', entries: [{ ...at('app/Checkout.php', 30), label: 'new Order()' }, { ...at('app/Checkout.php', 12, 17, 22), label: '$order = new Order();' }] },
      { label: 'Extended by', entries: [] },
      { label: 'Injected or type hinted', entries: [{ ...at('app/Ship.php', 8, 25, 30), label: 'Ship', description: 'App\\Ship' }] },
    ],
  });

  return postedMessages.at(-1) as any;
}

describe('the usages panel', () => {
  test('lists heading, then file, then line, skipping empty headings', async () => {
    const { listing } = await listOrders();

    expect(listing.subject).toBe('Order');
    expect(listing.count).toBe('3 references');
    expect(listing.groups.map((group: any) => [group.label, group.total])).toEqual([['Instantiated', 2], ['Injected or type hinted', 1]]);
    expect(listing.groups[0].files.map((file: any) => [file.directory, file.name])).toEqual([['app', 'Checkout.php']]);
    expect(listing.groups[0].files[0].entries.map((entry: any) => entry.place.line)).toEqual([12, 30]);
  });

  test('colours the line it quotes and marks the usage in it, once the indentation is taken off', async () => {
    const { listing } = await listOrders();
    const [quoted, unreadable] = listing.groups[0].files[0].entries;

    expect(quoted.highlight).toEqual([13, 18]);
    expect(quoted.tokens.map((token: any) => token.kind)).toEqual(['variable', 'plain', 'keyword', 'plain', 'class', 'plain']);
    expect(unreadable.highlight).toBeNull();
  });

  test('leaves a label that names a class rather than quoting its line plain', async () => {
    const { listing } = await listOrders();
    const [implementation] = listing.groups[1].files[0].entries;

    expect(implementation.tokens).toBeNull();
    expect(implementation.highlight).toBeNull();
    expect(implementation.description).toBe('App\\Ship');
  });

  test('opens the line the webview asks for, beside the editor when told to', async () => {
    await listOrders();

    view.receive({ type: 'open', uri: 'file:///p/app/Checkout.php', place: { line: 12, character: 17, endLine: 12, endCharacter: 22 }, isBeside: true, shouldFocusEditor: true });
    await Promise.resolve();

    const shown = shownDocuments.at(-1)!;
    expect(shown.uri.toString()).toBe('file:///p/app/Checkout.php');
    expect(shown.options).toEqual({ selection: new Range(12, 17, 12, 22), viewColumn: -2, preserveFocus: false, preview: false });
  });

  test('brings the panel up and says what it lists', async () => {
    await listOrders();

    expect(view.description).toBe('Order: 3 references');
    expect(executedCommands.at(-1)).toEqual({ command: 'phpToolbox.usages.focus', arguments: [] });
    expect(view.webview.html).toContain('webview:///ext/out/usages.js');
  });

  test('draws the listing again when the page says it is up, so nothing posted while it loaded is lost', async () => {
    const posted = await listOrders();

    view.receive({ type: 'ready' });

    expect(postedMessages.at(-1)).toEqual(posted);
    expect(postedMessages.at(-1)).not.toBe(posted);
  });
});
