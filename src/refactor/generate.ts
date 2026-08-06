import * as vscode from 'vscode';
import { ancestorsOf } from '../php/hierarchy';
import type { MethodDeclaration } from '../php/members';
import type { Declaration } from '../php/parser';
import { getPhpIndex, indexedFile, type IndexedFile } from '../php/phpIndex';
import { withProgress } from './apply';
import { classAt, memberIndent, memberInsertOffset } from './classEdits';
import { EditSet } from './editSet';
import { importEdit, typesUsedIn } from './imports';
import { indentUnit } from './textLayout';

interface OwnedMethod {
  file: IndexedFile;
  method: MethodDeclaration;
}

/** Methods the class has to declare and does not: interface methods and abstract ones. */
async function missingMethods(declaration: Declaration): Promise<OwnedMethod[]> {
  const files = await getPhpIndex();
  const all = files.flatMap((candidate) => candidate.parsed.declarations);
  const ancestors = ancestorsOf(declaration, all);
  const methodsOf = (fqn: string): OwnedMethod[] =>
    files.flatMap((candidate) =>
      candidate.parsed.methods
        .filter((method) => method.className === fqn)
        .map((method) => ({ file: candidate, method })),
    );

  const provided = new Set<string>(
    [declaration.fqn, ...ancestors.filter((ancestor) => ancestor.kind !== 'interface').map((ancestor) => ancestor.fqn)]
      .flatMap(methodsOf)
      .filter(({ method }) => !method.isAbstract)
      .map(({ method }) => method.name.toLowerCase()),
  );

  const required = ancestors
    .filter((ancestor) => ancestor.kind === 'interface' || ancestor.isAbstract)
    .flatMap((ancestor) => methodsOf(ancestor.fqn))
    .filter(({ method }) => method.isAbstract || method.className.length > 0);

  const wanted = new Map<string, OwnedMethod>();

  required
    .filter(({ method }) => !provided.has(method.name.toLowerCase()))
    .forEach((owned) => wanted.set(owned.method.name.toLowerCase(), owned));

  return [...wanted.values()];
}

/** The signature as written where it comes from, over the body it is given here. */
function stubOf(owned: OwnedMethod, indent: string, unit: string, body: string[]): string {
  const { file, method } = owned;
  const end = method.bodyStart === null ? method.end : file.text.lastIndexOf('{', method.bodyStart);
  const signature = file.text
    .slice(method.start, end)
    .trim()
    .replace(/\babstract\s+/g, '')
    .replace(/;$/, '')
    .replace(/\s+/g, ' ');

  return [
    `${indent}${signature}`,
    `${indent}{`,
    ...body.map((line) => `${indent}${unit}${line}`),
    `${indent}}`,
  ].join('\n');
}

/**
 * Writes the methods an interface or an abstract parent asks for, with their signatures
 * copied as they were declared — including the types, which is the part nobody enjoys
 * retyping.
 */
export async function implementMissing(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const declaration = classAt(file.parsed, editor.document.offsetAt(editor.selection.active));

  if (!declaration) {
    vscode.window.showWarningMessage('Place the cursor inside a class.');
    return;
  }

  const missing = await withProgress('Reading the contracts of the class…', () => missingMethods(declaration));

  if (missing.length === 0) {
    vscode.window.showInformationMessage(`${declaration.name} implements everything it has to.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    missing.map((owned) => ({
      label: owned.method.name,
      description: owned.method.className.split('\\').pop(),
      picked: true,
      owned,
    })),
    { title: `Methods to implement in ${declaration.name}`, canPickMany: true },
  );

  if (!picked || picked.length === 0) {
    return;
  }

  const unit = indentUnit(file.text);
  const indent = memberIndent(file.text, file.parsed, declaration);
  const anchor = memberInsertOffset(file.text, file.parsed, declaration, 'method');
  const edits = new EditSet();
  const body = picked
    .map((item) => stubOf(item.owned, indent, unit, [`// TODO: implement ${item.owned.method.name}()`]))
    .join('\n\n');

  edits.add({
    start: anchor.offset,
    end: anchor.offset,
    text: anchor.isFirstInBody ? `\n${body}\n` : `\n\n${body}`,
  });

  const types = picked.flatMap((item) =>
    typesUsedIn(item.owned.file, {
      start: item.owned.method.start,
      end: item.owned.method.bodyStart ?? item.owned.method.end,
    }),
  );
  const imports = importEdit(file.parsed, types);

  if (imports) {
    edits.add(imports);
  }

  const edit = new vscode.WorkspaceEdit();
  edits.all().forEach((textEdit) => {
    edit.replace(file.uri, file.mapper.range(textEdit.start, textEdit.end), textEdit.text);
  });

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(`${picked.length} method(s) implemented.`);
}

/** Methods the class inherits and could redeclare: what an override list is made of. */
async function overridableMethods(declaration: Declaration): Promise<OwnedMethod[]> {
  const files = await getPhpIndex();
  const all = files.flatMap((candidate) => candidate.parsed.declarations);
  const ancestors = ancestorsOf(declaration, all).filter((ancestor) => ancestor.kind !== 'interface');
  const declared = new Set(
    files
      .flatMap((candidate) => candidate.parsed.methods)
      .filter((method) => method.className === declaration.fqn)
      .map((method) => method.name.toLowerCase()),
  );

  const inherited = files.flatMap((file) =>
    file.parsed.methods
      .filter((method) => ancestors.some((ancestor) => ancestor.fqn === method.className))
      .map((method) => ({ file, method })),
  );

  const wanted = new Map<string, OwnedMethod>();

  inherited
    .filter(({ file, method }) => {
      // A private method is invisible to the child, and a final one refuses to be replaced.
      const modifiers = file.text.slice(method.start, method.nameStart);

      return (
        !method.isAbstract &&
        method.visibility !== 'private' &&
        !/\bfinal\b/.test(modifiers) &&
        !declared.has(method.name.toLowerCase())
      );
    })
    // Nearest ancestor first, so the signature copied is the one `parent::` reaches.
    .sort(
      (first, second) =>
        ancestors.findIndex((ancestor) => ancestor.fqn === first.method.className) -
        ancestors.findIndex((ancestor) => ancestor.fqn === second.method.className),
    )
    .forEach((owned) => {
      const key = owned.method.name.toLowerCase();

      if (!wanted.has(key)) {
        wanted.set(key, owned);
      }
    });

  return [...wanted.values()];
}

/**
 * The body an override starts with: a call to what it replaces, so the class keeps behaving
 * the way it did until the new behaviour is written in.
 *
 * A trait has no `parent`, so a method coming from one is left as a note instead.
 */
function overrideBody(owned: OwnedMethod, isFromTrait: boolean): string[] {
  const { method } = owned;

  if (isFromTrait) {
    return [`// TODO: override ${method.name}()`];
  }

  const args = method.params
    .map((param) => `${param.isVariadic ? '...' : ''}$${param.name}`)
    .join(', ');
  const call = `parent::${method.name}(${args});`;
  const isVoid = method.returnType === 'void' || method.returnType === 'never';

  return [isVoid || method.returnType === null ? call : `return ${call}`];
}

/**
 * Writes the chosen inherited methods as overrides.
 *
 * Only concrete ones are listed: a method an interface or an abstract parent asks for is
 * not an override but an obligation, and **Implement missing methods…** is where it lives.
 */
export async function overrideMethod(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const declaration = classAt(file.parsed, editor.document.offsetAt(editor.selection.active));

  if (!declaration) {
    vscode.window.showWarningMessage('Place the cursor inside a class.');
    return;
  }

  const candidates = await withProgress('Reading what the class inherits…', () =>
    overridableMethods(declaration),
  );

  if (candidates.length === 0) {
    vscode.window.showInformationMessage(`${declaration.name} has no inherited method left to override.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((owned) => ({
      label: owned.method.name,
      description: owned.method.className.split('\\').pop(),
      owned,
    })),
    { title: `Methods to override in ${declaration.name}`, canPickMany: true },
  );

  if (!picked || picked.length === 0) {
    return;
  }

  const unit = indentUnit(file.text);
  const indent = memberIndent(file.text, file.parsed, declaration);
  const anchor = memberInsertOffset(file.text, file.parsed, declaration, 'method');
  const edits = new EditSet();
  const traits = new Set(declaration.traits);
  const body = picked
    .map((item) => stubOf(item.owned, indent, unit, overrideBody(item.owned, traits.has(item.owned.method.className))))
    .join('\n\n');

  edits.add({
    start: anchor.offset,
    end: anchor.offset,
    text: anchor.isFirstInBody ? `\n${body}\n` : `\n\n${body}`,
  });

  const types = picked.flatMap((item) =>
    typesUsedIn(item.owned.file, {
      start: item.owned.method.start,
      end: item.owned.method.bodyStart ?? item.owned.method.end,
    }),
  );
  const imports = importEdit(file.parsed, types);

  if (imports) {
    edits.add(imports);
  }

  const edit = new vscode.WorkspaceEdit();
  edits.all().forEach((textEdit) => {
    edit.replace(file.uri, file.mapper.range(textEdit.start, textEdit.end), textEdit.text);
  });

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(`${picked.length} method(s) overridden.`);
}

/**
 * Writes a constructor that takes the chosen properties and assigns them.
 *
 * Properties already declared keep their declaration: promoting them is a separate step,
 * offered on the parameter itself.
 */
export async function generateConstructor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const declaration = classAt(file.parsed, editor.document.offsetAt(editor.selection.active));

  if (!declaration) {
    vscode.window.showWarningMessage('Place the cursor inside a class.');
    return;
  }

  if (file.parsed.methods.some((method) => method.className === declaration.fqn && method.name === '__construct')) {
    vscode.window.showWarningMessage(`${declaration.name} already has a constructor.`);
    return;
  }

  const properties = file.parsed.properties.filter(
    (property) => property.className === declaration.fqn && !property.isStatic,
  );

  if (properties.length === 0) {
    vscode.window.showWarningMessage(`${declaration.name} has no property to fill.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    properties.map((property) => ({
      label: `$${property.name}`,
      description: property.type ?? '',
      picked: true,
      property,
    })),
    { title: `Properties ${declaration.name} takes at construction`, canPickMany: true },
  );

  if (!picked || picked.length === 0) {
    return;
  }

  const unit = indentUnit(file.text);
  const indent = memberIndent(file.text, file.parsed, declaration);
  const params = picked
    .map((item) => `${item.property.type ? `${item.property.type} ` : ''}$${item.property.name}`)
    .join(', ');
  const body = picked.map((item) => `${indent}${unit}$this->${item.property.name} = $${item.property.name};`).join('\n');
  const constructor = [`${indent}public function __construct(${params})`, `${indent}{`, body, `${indent}}`].join('\n');

  // The constructor belongs above the methods, right after the properties it fills.
  const firstMethod = file.parsed.methods.find((method) => method.className === declaration.fqn);
  const anchor = firstMethod
    ? { offset: firstMethod.start, isFirstInBody: false }
    : memberInsertOffset(file.text, file.parsed, declaration, 'method');

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    file.uri,
    file.mapper.range(anchor.offset, anchor.offset),
    firstMethod ? `${constructor.trimStart()}\n\n${indent}` : anchor.isFirstInBody ? `\n${constructor}\n` : `\n\n${constructor}`,
  );

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(`Constructor with ${picked.length} parameter(s) written.`);
}
