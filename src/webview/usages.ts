import type { Token } from '../phpTokens';
import type { FromWebviewMessage, PreparedEntry, PreparedFile, PreparedGroup, PreparedListing, ToWebviewMessage } from '../usagesProtocol';

type PanelState = { listing: PreparedListing };

declare function acquireVsCodeApi(): {
  postMessage(message: FromWebviewMessage): void;
  getState(): PanelState | undefined;
  setState(state: PanelState): void;
};

const host = acquireVsCodeApi();
const root = document.getElementById('usages') as HTMLElement;
const entryOfRow = new WeakMap<HTMLElement, PreparedEntry>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  created.append(...children);

  return created;
}

function icon(path: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);

  return svg;
}

const CHEVRON = 'M5.7 13.7 4.3 12.3 8.6 8 4.3 3.7l1.4-1.4L11.4 8z';
const SPLIT = 'M2 3h12v10H2zm1 1v8h5V4zm6 0v8h4V4z';

/** The label as coloured spans, the usage inside it wrapped in a mark. */
function code(label: string, tokens: Token[] | null, highlight: [number, number] | null): HTMLElement {
  const line = element('span', 'code');
  const pieces = tokens ?? [{ kind: 'plain' as const, text: label }];
  let offset = 0;

  for (const token of pieces) {
    const start = offset;
    const end = offset + token.text.length;
    offset = end;

    if (!highlight || end <= highlight[0] || start >= highlight[1]) {
      line.append(element('span', `tk-${token.kind}`, token.text));
      continue;
    }

    const [from, to] = [Math.max(start, highlight[0]), Math.min(end, highlight[1])];
    const span = element('span', `tk-${token.kind}`);
    span.append(token.text.slice(0, from - start), element('mark', 'hit', token.text.slice(from - start, to - start)), token.text.slice(to - start));
    line.append(span);
  }

  return line;
}

function open(entry: PreparedEntry, isBeside: boolean, shouldFocusEditor: boolean): void {
  host.postMessage({ type: 'open', uri: entry.uri, place: entry.place, isBeside, shouldFocusEditor });
}

function renderEntry(entry: PreparedEntry): HTMLElement {
  const beside = element('button', 'beside', icon(SPLIT));
  beside.type = 'button';
  beside.title = 'Open to the side';
  beside.setAttribute('aria-label', 'Open to the side');
  beside.addEventListener('click', (event) => {
    event.stopPropagation();
    open(entry, true, true);
  });

  const row = element(
    'div',
    'row',
    element('span', 'line-number', String(entry.place.line + 1)),
    code(entry.label, entry.tokens, entry.highlight),
    ...(entry.description ? [element('span', 'description', entry.description)] : []),
    beside,
  );
  row.tabIndex = 0;
  row.title = entry.label;
  row.dataset.text = `${entry.label} ${entry.description ?? ''}`.toLowerCase();
  row.addEventListener('click', () => open(entry, false, false));
  entryOfRow.set(row, entry);

  return row;
}

function foldable(className: string, heading: HTMLElement, body: HTMLElement): HTMLElement {
  const section = element('section', className, heading, body);
  heading.addEventListener('click', () => section.classList.toggle('folded'));

  return section;
}

function renderFile(file: PreparedFile): HTMLElement {
  const heading = element(
    'div',
    'file',
    icon(CHEVRON),
    element('span', 'directory', file.directory ? `${file.directory}/` : ''),
    element('span', 'name', file.name),
    element('span', 'count', String(file.entries.length)),
  );
  heading.dataset.text = `${file.directory}/${file.name}`.toLowerCase();

  return foldable('file-section', heading, element('div', 'rows', ...file.entries.map(renderEntry)));
}

function renderGroup(group: PreparedGroup, hasHeading: boolean): HTMLElement {
  const files = element('div', 'files', ...group.files.map(renderFile));

  if (!hasHeading) {
    return files;
  }

  const heading = element('div', 'group', icon(CHEVRON), element('span', 'name', group.label), element('span', 'count', String(group.total)));

  return foldable('group-section', heading, files);
}

function applyFilter(needle: string): void {
  const wanted = needle.trim().toLowerCase();

  root.querySelectorAll<HTMLElement>('.row').forEach((row) => {
    const file = row.closest<HTMLElement>('.file-section')?.querySelector<HTMLElement>('.file');
    const haystack = `${row.dataset.text ?? ''} ${file?.dataset.text ?? ''}`;
    row.hidden = wanted !== '' && !haystack.includes(wanted);
  });
  root.querySelectorAll<HTMLElement>('.file-section, .group-section').forEach((section) => {
    section.hidden = section.querySelector('.row:not([hidden])') === null;
  });
}

function renderHeader(listing: PreparedListing): HTMLElement {
  const filter = element('input', 'filter');
  filter.type = 'search';
  filter.placeholder = 'Filter';
  filter.setAttribute('aria-label', 'Filter the usages');
  filter.addEventListener('input', () => applyFilter(filter.value));
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      filter.value = '';
      applyFilter('');
    }
  });

  return element('header', 'heading', code(listing.subject, listing.subjectTokens, null), element('span', 'pill', listing.count), filter);
}

/** Draws the listing and puts the keyboard on its first line, the way the panel is brought up focused. */
function render(listing: PreparedListing): void {
  root.replaceChildren(renderHeader(listing), ...listing.groups.map((group) => renderGroup(group, listing.groups.length > 1)));
  root.querySelector<HTMLElement>('.row')?.focus();
}

/** The rows the eye can see, in reading order, for the arrow keys to walk. */
function visibleRows(): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.row')].filter((row) => row.offsetParent !== null);
}

root.addEventListener('keydown', (event) => {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const entry = focused ? entryOfRow.get(focused) : undefined;

  if (event.key === 'Enter' && entry) {
    open(entry, event.ctrlKey || event.metaKey, true);
    event.preventDefault();
    return;
  }

  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
    return;
  }

  const rows = visibleRows();
  const current = focused ? rows.indexOf(focused) : -1;
  const next = event.key === 'ArrowDown' ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0);
  rows[next]?.focus();
  event.preventDefault();
});

window.addEventListener('message', (event: MessageEvent<ToWebviewMessage>) => {
  if (event.data.type === 'listing') {
    host.setState({ listing: event.data.listing });
    render(event.data.listing);
  }
});

const restored = host.getState();

if (restored) {
  render(restored.listing);
}

host.postMessage({ type: 'ready' });
