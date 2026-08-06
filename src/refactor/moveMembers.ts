import * as vscode from 'vscode';
import type { Declaration } from '../php/parser';
import { getPhpIndex, indexedFile, type IndexedFile } from '../php/phpIndex';
import type { Span } from '../php/scopes';
import { confirm } from './apply';
import { classAt, memberIndent, memberInsertOffset } from './classEdits';
import { EditSet } from './editSet';
import { importEdit, typesUsedIn } from './imports';
import { blankLineBefore, indentAt, memberSpan, reindent } from './textLayout';

type MemberKind = 'method' | 'property' | 'constant';

/** A member of a class, taken with the docblock written above it. */
interface Member {
  kind: MemberKind;
  name: string;
  span: Span;
  owner: Declaration;
}

interface ClassLocation {
  file: IndexedFile;
  declaration: Declaration;
}

function memberAt(file: IndexedFile, offset: number): Member | null {
  const owner = classAt(file.parsed, offset);

  if (!owner) {
    return null;
  }

  const candidates: Array<{ kind: MemberKind; name: string; start: number; end: number; className: string }> = [
    ...file.parsed.methods.map((method) => ({ kind: 'method' as const, name: method.name, start: method.start, end: method.end, className: method.className })),
    ...file.parsed.properties.map((property) => ({ kind: 'property' as const, name: property.name, start: property.start, end: property.end, className: property.className })),
    ...file.parsed.constants.map((constant) => ({ kind: 'constant' as const, name: constant.name, start: constant.start, end: constant.end, className: constant.className })),
  ];

  const found = candidates
    .filter((candidate) => candidate.className === owner.fqn)
    .map((candidate) => ({ ...candidate, span: memberSpan(file.text, candidate.start, candidate.end) }))
    .filter((candidate) => candidate.span.start <= offset && candidate.span.end >= offset)
    .sort((first, second) => first.span.end - first.span.start - (second.span.end - second.span.start))[0];

  return found ? { kind: found.kind, name: found.name, span: found.span, owner } : null;
}

/** Where the member can go: up to what the class inherits, or down to what inherits from it. */
async function relatives(owner: Declaration, direction: 'up' | 'down'): Promise<ClassLocation[]> {
  const files = await getPhpIndex();
  const wanted = new Set(direction === 'up' ? [owner.parent ?? '', ...owner.traits].filter(Boolean) : []);

  return files.flatMap((file) =>
    file.parsed.declarations
      .filter((declaration) =>
        direction === 'up'
          ? wanted.has(declaration.fqn)
          : declaration.parent === owner.fqn || declaration.traits.includes(owner.fqn),
      )
      .map((declaration) => ({ file, declaration })),
  );
}

async function pickClasses(candidates: ClassLocation[], title: string, isMulti: boolean): Promise<ClassLocation[]> {
  if (candidates.length === 0) {
    return [];
  }

  if (candidates.length === 1 && !isMulti) {
    return candidates;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.declaration.name,
      description: candidate.declaration.fqn,
      picked: true,
      candidate,
    })),
    { title, canPickMany: isMulti },
  );

  if (!picked) {
    return [];
  }

  return (Array.isArray(picked) ? picked : [picked]).map((item) => item.candidate);
}

/** The edits that write the member into one class, imports included. */
function insertInto(
  destination: ClassLocation,
  member: Member,
  code: string,
  sourceIndent: string,
  types: string[],
): EditSet {
  const edits = new EditSet();
  const anchor = memberInsertOffset(destination.file.text, destination.file.parsed, destination.declaration, member.kind);
  const indent = memberIndent(destination.file.text, destination.file.parsed, destination.declaration);
  const body = reindent(code.trimEnd(), sourceIndent, indent);

  edits.add({
    start: anchor.offset,
    end: anchor.offset,
    text: anchor.isFirstInBody ? `\n${body}\n` : `\n\n${body}`,
  });

  const imports = importEdit(destination.file.parsed, types);

  if (imports) {
    edits.add(imports);
  }

  return edits;
}

async function moveMember(direction: 'up' | 'down'): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const file = indexedFile(editor.document.uri, editor.document.getText());
  const member = memberAt(file, editor.document.offsetAt(editor.selection.active));

  if (!member) {
    vscode.window.showWarningMessage('Place the cursor on a method, a property or a constant.');
    return;
  }

  const candidates = await relatives(member.owner, direction);

  if (candidates.length === 0) {
    vscode.window.showWarningMessage(
      direction === 'up'
        ? `${member.owner.name} has no parent or trait in this project.`
        : `Nothing in this project extends ${member.owner.name}.`,
    );
    return;
  }

  const destinations = await pickClasses(
    candidates,
    direction === 'up' ? `Pull ${member.name} up to…` : `Push ${member.name} down to…`,
    direction === 'down',
  );

  if (destinations.length === 0) {
    return;
  }

  const isPrivate = /\bprivate\b/.test(file.text.slice(member.span.start, member.span.end));

  if (direction === 'up' && isPrivate && !(await confirm(`${member.name} is private: the class it leaves will not see it any more. Move it anyway?`))) {
    return;
  }

  const code = file.text.slice(member.span.start, member.span.end);
  const sourceIndent = indentAt(file.text, member.span.start + code.search(/\S/));
  const types = typesUsedIn(file, member.span);
  const edit = new vscode.WorkspaceEdit();
  const removal = new EditSet();

  removal.add({ start: blankLineBefore(file.text, member.span.start), end: member.span.end, text: '' });
  removal.all().forEach((textEdit) => {
    edit.replace(file.uri, file.mapper.range(textEdit.start, textEdit.end), textEdit.text);
  });

  destinations.forEach((destination) => {
    insertInto(destination, member, code, sourceIndent, types)
      .all()
      .forEach((textEdit) => {
        edit.replace(
          destination.file.uri,
          destination.file.mapper.range(textEdit.start, textEdit.end),
          textEdit.text,
        );
      });
  });

  await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  vscode.window.showInformationMessage(
    `Moved ${member.name} to ${destinations.map((destination) => destination.declaration.name).join(', ')}.`,
  );
}

export function pullMemberUp(): Promise<void> {
  return moveMember('up');
}

export function pushMemberDown(): Promise<void> {
  return moveMember('down');
}
