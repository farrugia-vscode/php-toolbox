import * as vscode from 'vscode';

/** One `"App\\": "app/"` entry of a composer autoload map. */
export interface Psr4Root {
  prefix: string;
  directory: vscode.Uri;
  /** Declared under `autoload-dev`, which is where the tests of a project live. */
  isDev: boolean;
}

/** A composer.json of the workspace, parsed. */
export interface ComposerProject {
  folder: vscode.Uri;
  manifest: any;
}

let roots: Psr4Root[] | null = null;
let projects: ComposerProject[] | null = null;

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\+$/, '');
}

function readRoots(composer: any, folder: vscode.Uri): Psr4Root[] {
  const sections = [
    { map: composer?.autoload?.['psr-4'], isDev: false },
    { map: composer?.['autoload-dev']?.['psr-4'], isDev: true },
  ];
  const found: Psr4Root[] = [];

  for (const { map, isDev } of sections) {
    for (const [prefix, target] of Object.entries(map ?? {})) {
      const directories = Array.isArray(target) ? target : [target];

      directories.forEach((directory) => {
        if (typeof directory === 'string') {
          found.push({
            prefix: normalizePrefix(prefix),
            directory: vscode.Uri.joinPath(folder, ...directory.split('/').filter(Boolean)),
            isDev,
          });
        }
      });
    }
  }

  return found;
}

/** Every composer.json of the workspace, parsed once. */
export async function getComposerProjects(): Promise<ComposerProject[]> {
  if (projects) {
    return projects;
  }

  const found: ComposerProject[] = [];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'composer.json'));

      found.push({ folder: folder.uri, manifest: JSON.parse(Buffer.from(raw).toString('utf8')) });
    } catch {
      continue;
    }
  }

  projects = found;
  return projects;
}

/**
 * The project's namespace-to-directory map. Without it a file move cannot know which
 * namespace the new location implies.
 */
export async function getPsr4Roots(): Promise<Psr4Root[]> {
  if (roots) {
    return roots;
  }

  const found = (await getComposerProjects()).flatMap((project) =>
    readRoots(project.manifest, project.folder),
  );

  // Longest directory first: `app/` and `app/Domain/` can both match a path.
  roots = found.sort((first, second) => second.directory.path.length - first.directory.path.length);
  return roots;
}

export function forgetPsr4Roots(): void {
  roots = null;
  projects = null;
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
