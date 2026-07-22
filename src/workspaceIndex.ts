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

const changed = new vscode.EventEmitter<vscode.Uri>();

/** Fires whenever a PHP file left the index, so derived indexes can drop their own entry. */
export const onDidChangeFile = changed.event;

function watchFiles(): void {
  if (watching) {
    return;
  }
  watching = true;

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.php');

  // Re-read rather than just forget: dropping the entry would hide the file from every
  // later search, since the index is only ever built once.
  const refresh = async (uri: vscode.Uri): Promise<void> => {
    const entry = await readFile(uri);
    if (entry) {
      index?.set(entry[0], entry[1]);
    }
    changed.fire(uri);
  };

  watcher.onDidChange((uri) => void refresh(uri));
  watcher.onDidCreate((uri) => void refresh(uri));
  watcher.onDidDelete((uri) => {
    index?.delete(uri.toString());
    changed.fire(uri);
  });
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
