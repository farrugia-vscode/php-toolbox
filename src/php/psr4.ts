import * as vscode from 'vscode';

/** One `"App\\": "app/"` entry of a composer autoload map. */
interface Psr4Root {
  prefix: string;
  directory: vscode.Uri;
}

let roots: Psr4Root[] | null = null;

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\+$/, '');
}

function readRoots(composer: any, folder: vscode.Uri): Psr4Root[] {
  const sections = [composer?.autoload?.['psr-4'], composer?.['autoload-dev']?.['psr-4']];
  const found: Psr4Root[] = [];

  for (const section of sections) {
    for (const [prefix, target] of Object.entries(section ?? {})) {
      const directories = Array.isArray(target) ? target : [target];

      directories.forEach((directory) => {
        if (typeof directory === 'string') {
          found.push({
            prefix: normalizePrefix(prefix),
            directory: vscode.Uri.joinPath(folder, ...directory.split('/').filter(Boolean)),
          });
        }
      });
    }
  }

  return found;
}

/**
 * The project's namespace-to-directory map. Without it a file move cannot know which
 * namespace the new location implies.
 */
export async function getPsr4Roots(): Promise<Psr4Root[]> {
  if (roots) {
    return roots;
  }

  const found: Psr4Root[] = [];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'composer.json'));
      found.push(...readRoots(JSON.parse(Buffer.from(raw).toString('utf8')), folder.uri));
    } catch {
      continue;
    }
  }

  // Longest directory first: `app/` and `app/Domain/` can both match a path.
  roots = found.sort((first, second) => second.directory.path.length - first.directory.path.length);
  return roots;
}

export function forgetPsr4Roots(): void {
  roots = null;
}

/** The namespace a file at `uri` should declare, according to composer. */
export async function namespaceForFile(uri: vscode.Uri): Promise<string | null> {
  for (const { prefix, directory } of await getPsr4Roots()) {
    const base = `${directory.path.replace(/\/$/, '')}/`;

    if (!uri.path.startsWith(base)) {
      continue;
    }

    const relative = uri.path.slice(base.length).split('/').slice(0, -1);
    return [prefix, ...relative].filter(Boolean).join('\\');
  }

  return null;
}

/** The directory a class in `namespace` should live in, according to composer. */
export async function directoryForNamespace(namespace: string): Promise<vscode.Uri | null> {
  for (const { prefix, directory } of await getPsr4Roots()) {
    if (namespace !== prefix && !namespace.startsWith(`${prefix}\\`)) {
      continue;
    }

    const relative = namespace.slice(prefix.length).split('\\').filter(Boolean);
    return vscode.Uri.joinPath(directory, ...relative);
  }

  return null;
}
