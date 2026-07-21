import * as vscode from 'vscode';

const EXCLUDED = '{**/vendor/**,**/node_modules/**,**/storage/**,**/public/**}';
const READ_BATCH_SIZE = 50;
const PROGRESS_DELAY = 400;

/**
 * Contents of every project PHP file, kept between searches. Reading them again on each
 * search is what makes a workspace-wide search feel slow on a large project.
 */
let index: Map<string, string> | null = null;
let indexing: Promise<Map<string, string>> | null = null;
let watching = false;

async function readFile(uri: vscode.Uri): Promise<[string, string] | null> {
  try {
    const content = await vscode.workspace.fs.readFile(uri);
    return [uri.toString(), Buffer.from(content).toString('utf8')];
  } catch {
    return null;
  }
}

function watchFiles(): void {
  if (watching) {
    return;
  }
  watching = true;

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.php');
  const forget = (uri: vscode.Uri): void => {
    index?.delete(uri.toString());
  };
  watcher.onDidChange(forget);
  watcher.onDidCreate(forget);
  watcher.onDidDelete(forget);
}

/** Only shown once the scan is slow enough to be noticed. */
function progress(total: number) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  const timer = setTimeout(() => item.show(), PROGRESS_DELAY);

  return {
    update: (done: number): void => {
      item.text = `$(sync~spin) PHP: indexing ${done}/${total} files`;
    },
    done: (): void => {
      clearTimeout(timer);
      item.dispose();
    },
  };
}

async function buildIndex(): Promise<Map<string, string>> {
  const files = await vscode.workspace.findFiles('**/*.php', EXCLUDED);
  const built = new Map<string, string>();
  const status = progress(files.length);

  try {
    for (let i = 0; i < files.length; i += READ_BATCH_SIZE) {
      status.update(i);
      const batch = await Promise.all(files.slice(i, i + READ_BATCH_SIZE).map(readFile));
      batch.forEach((entry) => {
        if (entry) {
          built.set(entry[0], entry[1]);
        }
      });
    }
  } finally {
    status.done();
  }

  watchFiles();
  return built;
}

export async function getIndex(): Promise<Map<string, string>> {
  if (index) {
    return index;
  }

  indexing ??= buildIndex().then((built) => {
    index = built;
    indexing = null;
    return built;
  });

  return indexing;
}

/** Read every PHP file once, in the background, so the first search does not pay for it. */
export function warmIndex(): void {
  void getIndex();
}
