import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';
import { fileWatchers, foundFiles, Uri } from './vscodeStub';

mock.module('vscode', () => vscodeStub);

// Other test files replace this module with a fixed index; the query asks for the real one.
const realIndex: string = '../src/workspaceIndex.ts?real';
const { getIndex } = (await import(realIndex)) as typeof import('../src/workspaceIndex');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const report = (listeners: Array<(uri: Uri) => void>, path: string) => listeners.forEach((listener) => listener(Uri.file(path)));

describe('the workspace index', () => {
  test('keeps a file composer writes under vendor out, as the first scan did', async () => {
    foundFiles.push(Uri.file('/p/app/Order.php'));
    await getIndex();

    report(fileWatchers.create, '/p/vendor/acme/lib/src/Client.php');
    report(fileWatchers.change, '/p/vendor/acme/lib/src/Client.php');
    report(fileWatchers.create, '/p/app/Invoice.php');
    await settle();

    expect([...(await getIndex()).keys()].sort()).toEqual(['file:///p/app/Invoice.php', 'file:///p/app/Order.php']);
  });
});
