import * as vscode from 'vscode';
import { shortNameOf } from '../php/fqn';
import type { MethodDeclaration } from '../php/members';
import type { Declaration } from '../php/parser';
import { getPhpIndex, indexedFile, type IndexedFile } from '../php/phpIndex';
import { confirm, withProgress } from './apply';
import { findCallSites, methodAtCursor, type CallSite } from './callSites';
import { reportUnresolved, type UnresolvedSite } from './unresolved';

/** A call, read as the plain mention the report shows. */
const callSite = (site: CallSite): UnresolvedSite => ({
  file: site.file,
  nameStart: site.call.nameStart,
  nameEnd: site.call.nameEnd,
});
import { memberIndent, memberInsertOffset } from './classEdits';
import { EditSet } from './editSet';
import { importEdit, typesUsedIn } from './imports';
import { afterLine, blankLineBefore, docblockStart, indentAt, lineStartOf, reindent } from './textLayout';

interface Destination {
  file: IndexedFile;
  declaration: Declaration;
}

/** Classes the method could move to, the ones the source already holds coming first. */
async function destinations(source: IndexedFile, method: MethodDeclaration): Promise<Destination[]> {
  const files = await getPhpIndex();
  const held = new Set(
    source.parsed.properties
      .filter((property) => property.className === method.className && property.type)
      .map((property) => property.type!.replace(/^\?/, '')),
  );

  return files
    .flatMap((file) =>
      file.parsed.declarations
        .filter((declaration) => declaration.fqn !== method.className && declaration.kind !== 'interface')
        .map((declaration) => ({ file, declaration })),
    )
    .sort((first, second) => {
      const isHeld = (candidate: Destination): number =>
        held.has(candidate.declaration.name) || held.has(candidate.declaration.fqn) ? 0 : 1;

      return isHeld(first) - isHeld(second) || first.declaration.name.localeCompare(second.declaration.name);
    });
}

/** The property of the source class that holds the destination, for instance methods. */
function routingProperty(source: IndexedFile, method: MethodDeclaration, destination: Destination): string | null {
  const property = source.parsed.properties.find(
    (candidate) =>
      candidate.className === method.className &&
      candidate.type !== null &&
      [destination.declaration.name, destination.declaration.fqn].includes(candidate.type.replace(/^\?/, '')),
  );

  return property?.name ?? null;
}

/** Members of the source the moved body would no longer reach. */
function strandedMembers(source: IndexedFile, method: MethodDeclaration, routing: string | null): string[] {
  const body = method.bodyStart === null ? '' : source.text.slice(method.bodyStart, method.bodyEnd ?? 0);

  return [...new Set([...body.matchAll(/\$this->(\w+)/g)].map((match) => match[1]))].filter(
    (name) => name !== routing,
  );
}

/**
 * Moves a method to another class and sends the calls to their new home.
 *
 * A static method moves on its own; an instance method needs the source to hold the
 * destination in a property, which is what the calls are routed through.
 */
export async function moveMethod(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const source = indexedFile(editor.document.uri, editor.document.getText());
  const location = await methodAtCursor(source, editor.document.offsetAt(editor.selection.active));

  if (!location || location.file.uri.toString() !== source.uri.toString()) {
    vscode.window.showWarningMessage('Place the cursor on a method declared in this file.');
    return;
  }

  const { method } = location;
  const candidates = await withProgress('Reading the classes of the project…', () => destinations(source, method));
  const picked = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: `$(symbol-class) ${candidate.declaration.name}`,
      description: candidate.declaration.fqn,
      candidate,
    })),
    { title: `Move ${method.name}() to…`, matchOnDescription: true },
  );

  if (!picked) {
    return;
  }

  const destination = picked.candidate;
  const routing = method.isStatic ? null : routingProperty(source, method, destination);

  if (!method.isStatic && !routing) {
    vscode.window.showWarningMessage(
      `${shortNameOf(method.className)} holds no ${destination.declaration.name} property to route the calls through. Make the method static, or add one.`,
    );
    return;
  }

  const stranded = strandedMembers(source, method, routing);

  if (stranded.length > 0) {
    const isConfirmed = await confirm(
      `The body uses ${stranded.map((name) => `$this->${name}`).join(', ')}, which ${destination.declaration.name} does not have. Move it anyway?`,
    );

    if (!isConfirmed) {
      return;
    }
  }

  const span = {
    start: blankLineBefore(source.text, lineStartOf(source.text, docblockStart(source.text, method.start))),
    end: afterLine(source.text, method.end),
  };
  const code = source.text.slice(span.start, span.end);
  const { sites, unresolved } = await withProgress(`Moving ${method.name}()…`, () => findCallSites(method));
  const byFile = new Map<IndexedFile, EditSet>();
  const add = (file: IndexedFile, edit: { start: number; end: number; text: string }): void => {
    const edits = byFile.get(file) ?? new EditSet();
    edits.add(edit);
    byFile.set(file, edits);
  };

  add(source, { start: span.start, end: span.end, text: '' });

  const anchor = memberInsertOffset(destination.file.text, destination.file.parsed, destination.declaration, 'method');
  const indent = memberIndent(destination.file.text, destination.file.parsed, destination.declaration);
  const body = reindent(code.trimEnd(), indentAt(source.text, method.start), indent);

  add(destination.file, {
    start: anchor.offset,
    end: anchor.offset,
    text: anchor.isFirstInBody ? `\n${body}\n` : `\n\n${body}`,
  });

  const imports = importEdit(destination.file.parsed, typesUsedIn(source, { start: method.start, end: method.end }));

  if (imports) {
    add(destination.file, imports);
  }

  const missed: string[] = [];

  sites.forEach((site) => {
    const receiver = site.file.text.slice(site.call.start, site.call.nameStart);

    if (method.isStatic) {
      add(site.file, { start: site.call.start, end: site.call.nameStart, text: `${destination.declaration.name}::` });

      // Two calls in the same file ask for the same import; the second edit is dropped.
      const needed = importEdit(site.file.parsed, [destination.declaration.fqn]);

      if (needed) {
        add(site.file, needed);
      }
      return;
    }

    if (receiver.trim() === '$this->') {
      add(site.file, { start: site.call.start, end: site.call.nameStart, text: `$this->${routing}->` });
      return;
    }

    missed.push(`${site.file.uri.path.split('/').pop()}:${site.file.mapper.at(site.call.start).line + 1}`);
  });

  const edit = new vscode.WorkspaceEdit();
  byFile.forEach((edits, file) => {
    edits.all().forEach((textEdit) => {
      edit.replace(file.uri, file.mapper.range(textEdit.start, textEdit.end), textEdit.text);
    });
  });

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });

  if (missed.length > 0) {
    vscode.window.showWarningMessage(`Calls left untouched, they are made on another object: ${missed.join(', ')}`);
  }

  vscode.window.showInformationMessage(`${method.name}() moved to ${destination.declaration.name}.`);
  await reportUnresolved(`${method.name}()`, unresolved.map(callSite));
}
