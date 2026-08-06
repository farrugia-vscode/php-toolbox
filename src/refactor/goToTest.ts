import * as vscode from 'vscode';
import type { Declaration } from '../php/parser';
import { getPhpIndex, indexedFile } from '../php/phpIndex';
import { getComposerProjects, getPsr4Roots, type Psr4Root } from '../php/psr4';
import { indentUnit } from './textLayout';
import { testFileContents, type TestStyle } from './testSkeleton';

/** Directories a test root is split into, offered when the test has to be created. */
const KNOWN_SUITES = ['Unit', 'Feature', 'Integration'];

async function open(uri: vscode.Uri): Promise<void> {
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

/** Files whose name is exactly this, anywhere but in vendor. */
async function filesNamed(name: string): Promise<vscode.Uri[]> {
  return vscode.workspace.findFiles(`**/${name}.php`, '**/vendor/**', 20);
}

async function pickFile(candidates: vscode.Uri[], title: string): Promise<vscode.Uri | null> {
  if (candidates.length <= 1) {
    return candidates[0] ?? null;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    { title },
  );

  return picked?.uri ?? null;
}

/** The psr-4 root the file belongs to, which says what its namespace is rooted at. */
function rootOf(roots: Psr4Root[], uri: vscode.Uri): Psr4Root | null {
  return roots.find((root) => uri.path.startsWith(`${root.directory.path.replace(/\/$/, '')}/`)) ?? null;
}

/**
 * Where the tests of the project live.
 *
 * Read from `autoload-dev` rather than assumed: a project that autoloads its tests under
 * something else than `Tests\` still says so there.
 */
async function testRoot(): Promise<Psr4Root | null> {
  const roots = await getPsr4Roots();
  const dev = roots.filter((root) => root.isDev);

  return (
    dev.find((root) => root.directory.path.endsWith('/tests')) ??
    dev.find((root) => root.prefix.toLowerCase() === 'tests') ??
    dev[0] ??
    null
  );
}

/** Pest or PHPUnit, read from what the project requires. */
async function styleOf(): Promise<TestStyle> {
  const projects = await getComposerProjects();
  const isPest = projects.some((project) =>
    Object.keys({ ...project.manifest?.['require-dev'], ...project.manifest?.require }).some((name) =>
      name.startsWith('pestphp/pest'),
    ),
  );

  return isPest ? 'pest' : 'phpunit';
}

/** The project's own TestCase when it has one, since that is what its tests extend. */
async function baseClassOf(root: Psr4Root): Promise<string> {
  const declarations = (await getPhpIndex()).flatMap((file) => file.parsed.declarations);
  const own = declarations.find(
    (declaration) => declaration.fqn === `${root.prefix}\\TestCase` && declaration.kind === 'class',
  );

  return own?.fqn ?? 'PHPUnit\\Framework\\TestCase';
}

/** The suite the new test goes in, asked for only when the project has more than one. */
async function pickSuite(root: Psr4Root): Promise<string | null> {
  const existing: string[] = [];

  for (const suite of KNOWN_SUITES) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root.directory, suite));
      existing.push(suite);
    } catch {
      continue;
    }
  }

  if (existing.length === 0) {
    return '';
  }

  if (existing.length === 1) {
    return existing[0];
  }

  const picked = await vscode.window.showQuickPick(existing, { title: 'Which suite does this test belong to?' });

  return picked ?? null;
}

/** Writes the test file for a class and opens it. */
async function createTest(subject: Declaration, sourceUri: vscode.Uri, isStrict: boolean, unit: string): Promise<void> {
  const root = await testRoot();

  if (!root) {
    vscode.window.showErrorMessage('No composer autoload-dev psr-4 root to put a test in.');
    return;
  }

  const suite = await pickSuite(root);

  if (suite === null) {
    return;
  }

  const sourceRoot = rootOf(await getPsr4Roots(), sourceUri);
  // The namespace of the class under its own root is the path its test mirrors.
  const relative = sourceRoot
    ? subject.fqn.slice(sourceRoot.prefix.length + 1).split('\\').slice(0, -1)
    : [];
  const segments = [...(suite === '' ? [] : [suite]), ...relative];
  const name = `${subject.name}Test`;
  const target = vscode.Uri.joinPath(root.directory, ...segments, `${name}.php`);
  const style = await styleOf();

  const contents = testFileContents(
    {
      name,
      namespace: [root.prefix, ...segments].join('\\'),
      subject: subject.fqn,
      style,
      baseClass: await baseClassOf(root),
      isStrict,
    },
    unit,
  );

  const edit = new vscode.WorkspaceEdit();

  edit.createFile(target, { ignoreIfExists: true });
  edit.insert(target, new vscode.Position(0, 0), contents);

  await vscode.workspace.applyEdit(edit);
  await open(target);
}

/**
 * Jumps between a class and its test, and offers to write the test when there is none.
 *
 * Matching is done on the file name rather than on a class name: a Pest file declares no
 * class at all, so `InvoicerTest.php` is the only thing both styles have in common.
 */
export async function goToTest(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const document = editor.document;
  const fileName = document.uri.path.split('/').pop()?.replace(/\.php$/, '') ?? '';

  if (fileName.endsWith('Test')) {
    const subject = await pickFile(await filesNamed(fileName.replace(/Test$/, '')), 'Class under test');

    if (!subject) {
      vscode.window.showInformationMessage(`Nothing named ${fileName.replace(/Test$/, '')} in this project.`);
      return;
    }

    await open(subject);
    return;
  }

  const existing = await pickFile(await filesNamed(`${fileName}Test`), `Tests of ${fileName}`);

  if (existing) {
    await open(existing);
    return;
  }

  const text = document.getText();
  const file = indexedFile(document.uri, text);
  const declaration =
    file.parsed.declarations.find((candidate) => candidate.name === fileName) ?? file.parsed.declarations[0];

  if (!declaration) {
    vscode.window.showWarningMessage('This file declares no class to test.');
    return;
  }

  const answer = await vscode.window.showInformationMessage(
    `${fileName} has no test. Create ${fileName}Test?`,
    { modal: true },
    'Create',
  );

  if (answer !== 'Create') {
    return;
  }

  await createTest(declaration, document.uri, /declare\s*\(\s*strict_types/.test(text), indentUnit(text));
}
