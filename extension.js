const vscode = require('vscode');

const MEMBER_KINDS = new Set([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Field,
  vscode.SymbolKind.EnumMember,
]);

const CLASS_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
]);

const KIND_ICON = {
  [vscode.SymbolKind.Method]: 'symbol-method',
  [vscode.SymbolKind.Property]: 'symbol-property',
  [vscode.SymbolKind.Constant]: 'symbol-constant',
  [vscode.SymbolKind.Field]: 'symbol-field',
  [vscode.SymbolKind.EnumMember]: 'symbol-enum-member',
};

function findClassLikeSymbols(symbols) {
  const found = [];
  const walk = (list) => {
    for (const symbol of list) {
      if (CLASS_KINDS.has(symbol.kind)) {
        found.push(symbol);
      }
      if (symbol.children && symbol.children.length > 0) {
        walk(symbol.children);
      }
    }
  };
  walk(symbols);
  return found;
}

function pickEnclosingClass(classSymbols, position) {
  const containing = classSymbols.filter((symbol) => symbol.range.contains(position));
  if (containing.length > 0) {
    return containing.sort(
      (first, second) =>
        (second.range.start.line - first.range.start.line) ||
        (first.range.end.line - second.range.end.line),
    )[0];
  }
  return classSymbols[0];
}

function findWordPosition(document, word, fromLine, toLine) {
  const shortName = word.split('\\').pop();
  const pattern = new RegExp(`\\b${shortName}\\b`);
  for (let line = fromLine; line <= toLine && line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = pattern.exec(text);
    if (match) {
      return new vscode.Position(line, match.index);
    }
  }
  return null;
}

function parseTypeReferences(document, classSymbol) {
  const names = new Set();
  const startLine = classSymbol.selectionRange.start.line;
  const endLine = classSymbol.range.end.line;

  // Header: everything from the class name line up to the opening brace.
  let header = '';
  let headerEndLine = startLine;
  for (let line = startLine; line <= endLine && line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    header += ' ' + text;
    headerEndLine = line;
    if (text.includes('{')) {
      break;
    }
  }

  const collect = (regex) => {
    let match;
    while ((match = regex.exec(header)) !== null) {
      match[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => names.add(name));
    }
  };
  collect(/\bextends\s+([\w\\,\s]+?)(?:\bimplements\b|\{|$)/g);
  collect(/\bimplements\s+([\w\\,\s]+?)(?:\{|$)/g);

  // Trait uses inside the class body.
  const traitNames = new Set();
  for (let line = headerEndLine; line <= endLine && line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = /^\s*use\s+([A-Za-z_\\][\w\\]*(?:\s*,\s*[A-Za-z_\\][\w\\]*)*)\s*[;{]/.exec(text);
    if (match) {
      match[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => {
          names.add(name);
          traitNames.add(name);
        });
    }
  }

  return { names, headerRange: [startLine, headerEndLine], traitNames };
}

function normalizeDefinition(result) {
  if (!result || result.length === 0) {
    return null;
  }
  const first = result[0];
  if (first.targetUri) {
    return { uri: first.targetUri, position: first.targetSelectionRange.start };
  }
  return { uri: first.uri, position: first.range.start };
}

async function collect(uri, classSymbol, seen, members, depth) {
  const key = uri.toString() + '#' + classSymbol.name;
  if (depth > 25 || seen.has(key)) {
    return;
  }
  seen.add(key);

  for (const child of classSymbol.children || []) {
    if (!MEMBER_KINDS.has(child.kind) || members.has(child.name)) {
      continue;
    }
    members.set(child.name, {
      name: child.name,
      detail: child.detail,
      kind: child.kind,
      className: classSymbol.name,
      uri,
      range: child.selectionRange,
    });
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const { names } = parseTypeReferences(document, classSymbol);

  for (const name of names) {
    const namePosition = findWordPosition(
      document,
      name,
      classSymbol.selectionRange.start.line,
      classSymbol.range.end.line,
    );
    if (!namePosition) {
      continue;
    }
    const definition = normalizeDefinition(
      await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, namePosition),
    );
    if (!definition) {
      continue;
    }
    const parentSymbols = findClassLikeSymbols(
      (await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        definition.uri,
      )) || [],
    );
    const parentSymbol =
      parentSymbols.find((symbol) => symbol.range.contains(definition.position)) ||
      parentSymbols.find((symbol) => symbol.name.split('\\').pop() === name.split('\\').pop());
    if (parentSymbol) {
      await collect(definition.uri, parentSymbol, seen, members, depth + 1);
    }
  }
}

async function show() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'php') {
    return;
  }

  const symbols =
    (await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      editor.document.uri,
    )) || [];
  const classSymbols = findClassLikeSymbols(symbols);
  if (classSymbols.length === 0) {
    vscode.window.showInformationMessage('No class found in this file.');
    return;
  }

  const classSymbol = pickEnclosingClass(classSymbols, editor.selection.active);
  const members = new Map();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Resolving inherited symbols…' },
    () => collect(editor.document.uri, classSymbol, new Set(), members, 0),
  );

  const ownName = classSymbol.name.split('\\').pop();
  const items = [...members.values()]
    .sort((first, second) => first.name.localeCompare(second.name))
    .map((member) => {
      const icon = KIND_ICON[member.kind] || 'symbol-misc';
      const from = member.className.split('\\').pop();
      return {
        label: `$(${icon}) ${member.name}`,
        description: from === ownName ? '' : from,
        detail: member.detail || '',
        member,
      };
    });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${ownName} — ${items.length} members (incl. inherited)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(picked.member.uri);
  const opened = await vscode.window.showTextDocument(document);
  opened.selection = new vscode.Selection(
    picked.member.range.start,
    picked.member.range.start,
  );
  opened.revealRange(picked.member.range, vscode.TextEditorRevealType.InCenter);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('phpInheritedSymbols.show', show),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
