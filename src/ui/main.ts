// The app: Import → Reading → Mirror → the play loop (rooms, campfires, boss, Apply, Undo). The import, reading and
// mirror pages are plain; the play loop owns #app once it starts. Every string from a log is set with textContent,
// never parsed as HTML. Routes: /errata/ is the game; "#play-ui" starts the sample straight into the play loop;
// "#play" opens the plain debug render of every view field.

import './style.css';
import './material.css';
import type { Agent } from '../model';
import { analyse, type Analysis } from '../pipeline';
import type { RouteNode } from '../rooms';
import { newDeck, type DeckState } from '../deck/deck';
import { budgetFor, weigh } from '../deck/file';
import { asset } from './playloop/cards/dom';
import { strapText } from './playloop/contract';
import { actLine, mirrorRows } from './mirror-view';
import { CODEX_OVERRIDE } from '../deck/lanes';
import { ensureWritable, fsaRoot, prefixedRoot } from '../apply/fsa-root';
import type { Root } from '../apply/types';
import { claudeCandidates, codexCandidates, droppedCandidates, selectRun, type Candidate, type Selection } from './importer';
import { resetSample, sampleDirs, sampleFiles, SAMPLE_LABEL } from './sample';
import type { ParseReply, ParseRequest } from './worker';
import { createPlayState, type ApplyPort } from './playloop/adapter';
import { Controller } from './playloop/controller';
import { mountDebug } from './playloop/debug';
import { mountScreens } from './playloop/mount';

type Step = 'import' | 'reading' | 'mirror' | 'play';

interface Progress {
  file: string;
  fileIndex: number;
  files: number;
  fileBytes: number;
  fileSize: number;
  bytesDone: number;
  bytesTotal: number;
  sessionsDone: number;
}

interface State {
  step: Step;
  mode: 'sample' | 'real' | null;
  busy: string | null;
  error: string | null;
  candidates: Candidate[];
  selection: Selection | null;
  progress: Progress | null;
  read: { ms: number; bytes: number; failed: number; cancelled: boolean } | null;
  A: Analysis | null;
  deck: DeckState;
  dirs: { claude: FileSystemDirectoryHandle | null; codex: FileSystemDirectoryHandle | null; agents: FileSystemDirectoryHandle | null; codexLoaded: boolean; claudeLoaded: boolean };
  roots: Root[] | null;
  /** The two global files as read on the import page once a folder is chosen (null = absent; undefined = not read). */
  books: { claude?: Uint8Array | null; codex?: Uint8Array | null };
}

const S: State = {
  step: 'import',
  mode: null,
  busy: null,
  error: null,
  candidates: [],
  selection: null,
  progress: null,
  read: null,
  A: null,
  deck: newDeck(null, null),
  dirs: { claude: null, codex: null, agents: null, codexLoaded: false, claudeLoaded: false },
  roots: null,
  books: {},
};

// ---------------------------------------------------------------- tiny DOM helpers (text only)
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'disabled') (el as HTMLButtonElement).disabled = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const app = document.getElementById('app')!;
const hasFSA = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
const pick = (o: object) => (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker(o);
const mib = (b: number) => (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0);
const hash = () => location.hash;

function set(p: Partial<State>): void {
  Object.assign(S, p);
  render();
}

function fail(e: unknown): void {
  set({ busy: null, error: String((e as Error)?.message ?? e) });
}

// ---------------------------------------------------------------- import
async function pickClaude(): Promise<void> {
  try {
    const dir = await pick({ id: 'claude-home', mode: 'read' });
    set({ busy: 'Listing Claude Code sessions…', error: null });
    const found = await claudeCandidates(dir);
    S.dirs.claude = dir;
    // The book's strap shows CLAUDE.md's real weight as soon as the folder is chosen (read only; nothing is written).
    S.books.claude = await readIn(dir, 'CLAUDE.md');
    S.candidates = [...S.candidates.filter((c) => c.agent !== 'claude'), ...found];
    set({ busy: null, mode: 'real', selection: selectRun(S.candidates) });
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') fail(e);
  }
}

async function pickCodexSessions(): Promise<void> {
  try {
    const dir = await pick({ id: 'codex-sessions', mode: 'read' });
    set({ busy: 'Listing Codex rollouts…', error: null });
    const found = await codexCandidates(dir);
    S.candidates = [...S.candidates.filter((c) => c.agent !== 'codex'), ...found];
    set({ busy: null, mode: 'real', selection: selectRun(S.candidates) });
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') fail(e);
  }
}

async function onDrop(files: File[]): Promise<void> {
  const found = await droppedCandidates(files);
  S.candidates = [...S.candidates, ...found];
  set({ mode: 'real', selection: selectRun(S.candidates, 3650) });
}

let worker: Worker | null = null;

function parse(files: { rel: string; blob: Blob; agent?: Agent }[]): Promise<Extract<ParseReply, { type: 'done' }>> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker = w;
    w.onmessage = (ev: MessageEvent<ParseReply>) => {
      if (ev.data.type === 'progress') {
        S.progress = ev.data;
        render();
      } else {
        w.terminate();
        worker = null;
        resolve(ev.data);
      }
    };
    w.onerror = (e) => {
      w.terminate();
      worker = null;
      reject(new Error(e.message));
    };
    w.postMessage({ type: 'parse', files } satisfies ParseRequest);
  });
}

function cancelRead(): void {
  worker?.postMessage({ type: 'cancel' } satisfies ParseRequest);
}

async function readIn(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch {
    return null;
  }
}

async function startRun(files: { rel: string; blob: Blob; agent?: Agent }[]): Promise<void> {
  try {
    set({ step: 'reading', error: null, progress: null });
    const done = await parse(files);
    S.read = { ms: done.ms, bytes: done.bytes, failed: done.failed, cancelled: done.cancelled };
    const claudeMd = S.dirs.claude ? await readIn(S.dirs.claude, 'CLAUDE.md') : null;
    const codexMd = S.dirs.codex && S.dirs.codexLoaded ? await readIn(S.dirs.codex, 'AGENTS.md') : null;
    const override = S.dirs.codex && S.dirs.codexLoaded ? await readIn(S.dirs.codex, CODEX_OVERRIDE) : null;
    S.dirs.claudeLoaded = !!S.dirs.claude;
    S.deck = newDeck(claudeMd, codexMd, override);
    S.A = analyse(done.sessions, { episodes: done.episodes, importedCards: S.deck.imported.length });
    set({ step: 'mirror' });
    if (hash() === '#play' || hash() === '#play-ui') startPlayLoop();
  } catch (e) {
    set({ step: 'import' });
    fail(e);
  }
}

/** The sample always starts from the shipped files: an earlier run's Apply in this browser is wiped first. */
async function startSample(): Promise<void> {
  try {
    S.mode = 'sample';
    S.candidates = [];
    set({ busy: 'Loading the synthetic sample…', error: null });
    await resetSample();
    const dirs = await sampleDirs();
    S.dirs = { claude: dirs.claude, codex: dirs.codex, agents: dirs.agents, claudeLoaded: true, codexLoaded: true };
    S.roots = null;
    S.busy = null;
    await startRun(await sampleFiles());
  } catch (e) {
    fail(e);
  }
}

/** Optional at the mirror: read AGENTS.md now so its weight and disagreements show during the act (write access is asked at Apply). */
async function readCodexHome(): Promise<void> {
  try {
    const dir = await pick({ id: 'codex-home', mode: 'read' });
    S.dirs.codex = dir;
    S.dirs.codexLoaded = true;
    S.roots = null;
    const claude = S.dirs.claude ? await readIn(S.dirs.claude, 'CLAUDE.md') : null;
    S.books.codex = await readIn(dir, 'AGENTS.md');
    S.deck = newDeck(claude, S.books.codex, await readIn(dir, CODEX_OVERRIDE));
    render();
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') fail(e);
  }
}

// ---------------------------------------------------------------- Apply's folders (the play loop writes through these)
function rootsFor(): Root[] | null {
  if (S.roots) return S.roots;
  if (!S.dirs.claude || !S.dirs.codex) return null;
  const label = S.mode === 'sample' ? 'sample' : '~';
  const claude = fsaRoot('claude', S.dirs.claude, `${label}/.claude`);
  const codex = fsaRoot('codex', S.dirs.codex, `${label}/.codex`);
  const roots: Root[] = [claude, codex, fsaRoot('backup', S.dirs.claude, `${label}/.claude`), prefixedRoot(claude, 'claude-skills', 'skills', `${label}/.claude/skills`)];
  if (S.dirs.agents) roots.push(prefixedRoot(fsaRoot('codex-skills', S.dirs.agents, `${label}/.agents`), 'codex-skills', 'skills', `${label}/.agents/skills`));
  S.roots = roots;
  return roots;
}

/** The play loop writes through the granted folders; the engine's write protocol (backups, read-back, Undo) does the rest. */
function playPort(): ApplyPort {
  return {
    roots: () => rootsFor(),
    needs: () => ({ claude: !S.dirs.claudeLoaded || (S.mode === 'real' && !S.dirs.claude), codex: !S.dirs.codexLoaded || (S.mode === 'real' && !S.dirs.codex), agents: !S.dirs.agents }),
    readSkill: (root, rel) => {
      const byId = new Map((rootsFor() ?? []).map((r) => [r.id, r]));
      if (root === 'codex-legacy-skills') return S.dirs.codex ? prefixedRoot(fsaRoot('codex', S.dirs.codex, 'codex'), 'codex', 'skills', '~/.codex/skills').read(rel) : Promise.resolve(null);
      return byId.get(root)?.read(rel) ?? Promise.resolve(null);
    },
    ensureWritable: async () => S.mode !== 'real' || ((await ensureWritable(S.dirs.claude!)) && (await ensureWritable(S.dirs.codex!)) && (!S.dirs.agents || (await ensureWritable(S.dirs.agents)))),
    grant: async (which) => {
      try {
        const dir = await pick({ id: `${which}-home`, mode: 'readwrite' });
        S.dirs[which] = dir;
        S.roots = null;
        if (which === 'claude') S.dirs.claudeLoaded = true;
        if (which === 'codex') S.dirs.codexLoaded = true;
        return {
          claude: S.dirs.claude ? await readIn(S.dirs.claude, 'CLAUDE.md') : null,
          codex: S.dirs.codex ? await readIn(S.dirs.codex, 'AGENTS.md') : null,
          override: S.dirs.codex ? await readIn(S.dirs.codex, CODEX_OVERRIDE) : null,
          loaded: { claude: S.dirs.claudeLoaded, codex: S.dirs.codexLoaded },
        };
      } catch {
        return null;
      }
    },
  };
}

let unmountPlay: (() => void) | null = null;
function startPlayLoop(): void {
  if (!S.A) return;
  const state = createPlayState({ analysis: S.A, deck: S.deck, sample: S.mode === 'sample', loaded: { claude: S.dirs.claudeLoaded, codex: S.dirs.codexLoaded } });
  const ctl = new Controller(state, playPort(), { viewport: { w: window.innerWidth, h: window.innerHeight }, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  S.step = 'play';
  unmountPlay?.();
  document.body.classList.add('is-play');
  unmountPlay = hash() === '#play' ? mountDebug(app, ctl) : mountScreens(app, ctl);
}

// ---------------------------------------------------------------- pages: import, reading, mirror (in the material)
function steps(): HTMLElement {
  const names: [Step, string][] = [
    ['import', 'Import'],
    ['reading', 'Reading'],
    ['mirror', 'Mirror'],
    ['play', 'The act'],
  ];
  return h('nav', { class: 'mt-steps' }, h('span', { class: 'brand' }, 'Errata'), S.mode === 'sample' ? h('span', { class: 'chip' }, SAMPLE_LABEL) : null, ...names.map(([k, n]) => h('span', { class: S.step === k ? 'on' : '' }, n)));
}

/** A page in the material: the world plate behind, the title on a paper plate in the sky, the rest on the wood. */
function material(cls: string, sky: Child[], wood: Child[]): HTMLElement {
  const page = h('div', { class: `mt ${cls}` }, h('header', { class: 'mt-sky' }, h('div', { class: 'mt-plate' }, steps(), ...sky)), h('section', { class: 'mt-wood' }, ...wood));
  page.style.setProperty('--mt-plate', `url("${asset('layout/world-table.webp')}")`);
  page.style.setProperty('--mt-wood', `url("${asset('layout/world-table-wood.webp')}")`);
  page.style.setProperty('--mt-plate-p', `url("${asset('layout/world-portrait.webp')}")`);
  page.style.setProperty('--mt-wood-p', `url("${asset('layout/world-portrait-wood.webp')}")`);
  return page;
}

/** One book lying closed on the wood: its strap at the file's real weight once read, else "not read yet". */
function closedBook(name: string, path: string, bytes: Uint8Array | null | undefined, tilt: string, unread: string): HTMLElement {
  let strap: HTMLElement;
  let fig: HTMLElement;
  if (bytes === undefined) {
    strap = h('div', { class: 'mt-strap' }, h('i', { style: 'width:0%' }));
    fig = h('p', { class: 'mt-book-fig' }, h('span', { class: 'is-none' }, unread));
  } else {
    // Honesty map: the strap = weigh(file).total against budgetFor(file).allowance (the same numbers the table shows).
    const now = weigh(bytes ?? new Uint8Array(0)).total;
    const allowance = budgetFor(bytes).allowance;
    const t = strapText(now, allowance);
    strap = h('div', { class: `mt-strap${now > allowance ? ' is-over' : ''}` }, h('i', { style: `width:${Math.min(100, Math.round((now / Math.max(allowance, now, 1)) * 1000) / 10)}%` }));
    fig = h('p', { class: 'mt-book-fig' }, h('span', {}, bytes === null ? 'no file yet: it starts empty' : t.weight), h('span', {}, t.left));
  }
  const b = h('div', { class: `mt-book ${tilt}`, role: 'img', 'aria-label': `${name}, closed: ${fig.textContent}` }, h('span', { class: 'mt-book-name' }, name), h('span', { class: 'mt-book-path' }, path), strap, fig);
  return b;
}

function viewImport(): HTMLElement {
  const sel = S.selection;
  // A file input for the same path as the drop (keyboard, touch, and browsers without folder access).
  const input = h('input', { type: 'file', accept: '.jsonl', multiple: 'multiple', class: 'mt-file', 'aria-label': 'Choose .jsonl session files' }) as HTMLInputElement;
  input.addEventListener('change', () => void onDrop([...(input.files ?? [])]));
  const drop = h('div', { class: 'mt-slip mt-drop tilt-c' }, 'Or drop .jsonl session files here, or pick them: ', input);
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('hot');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('hot');
    void onDrop([...(e.dataTransfer?.files ?? [])]);
  });
  const claudeN = sel?.chosen.filter((c) => c.agent === 'claude').length ?? 0;
  const codexN = sel?.chosen.filter((c) => c.agent === 'codex').length ?? 0;
  const day = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : '–');
  const choice = (label: string, sub: string, onclick: () => void, cls: string) => h('button', { class: `mt-slip mt-choice ${cls}`, onclick }, h('b', {}, label), h('span', {}, sub));
  return material(
    'mt-import',
    [h('h1', {}, 'Your rules file is a deck.'), h('p', { class: 'mt-sub' }, 'Read your recent Claude Code and Codex sessions, review what happened, and write better rules into CLAUDE.md and AGENTS.md. Everything stays in this tab.')],
    [
      h('div', { class: 'mt-row' }, closedBook('CLAUDE.md', '~/.claude/CLAUDE.md', S.books.claude, 'tilt-a', 'not read yet'), closedBook('AGENTS.md', '~/.codex/AGENTS.md', S.books.codex, 'tilt-b', 'read at the mirror or at Apply')),
      h(
        'div',
        { class: 'mt-row' },
        choice('Play the synthetic sample', 'Twelve made-up sessions and two small files. Nothing of yours is read.', () => void startSample(), 'is-primary tilt-a'),
        hasFSA && choice('Choose your ~/.claude folder', 'Your Claude Code sessions and CLAUDE.md, read only.', () => void pickClaude(), 'tilt-b'),
        hasFSA && choice('Choose ~/.codex/sessions', 'Your Codex rollouts, read only.', () => void pickCodexSessions(), 'tilt-c'),
      ),
      !hasFSA && h('p', { class: 'mt-slip mt-privacy' }, 'This browser cannot open folders. Drop session files instead; Apply then gives you the lines to paste.'),
      drop,
      h('p', { class: 'mt-slip mt-privacy tilt-b' }, 'Only projects/**/*.jsonl under ~/.claude and rollout-*.jsonl under ~/.codex/sessions are read, each file in full. Secrets are redacted as each line is parsed.'),
      sel &&
        h(
          'div',
          { class: 'mt-slip mt-run tilt-c' },
          h('h2', {}, 'This run'),
          h(
            'table',
            {},
            h('tr', {}, h('td', {}, 'Window'), h('td', { class: 'num' }, `last ${sel.window.days} days, up to ${sel.window.perAgent} per agent`)),
            h('tr', {}, h('td', {}, 'Dates'), h('td', { class: 'num' }, `${day(sel.dates.from)} to ${day(sel.dates.to)}`)),
            h('tr', {}, h('td', {}, 'Claude Code sessions'), h('td', { class: 'num' }, String(claudeN))),
            h('tr', {}, h('td', {}, 'Codex sessions'), h('td', { class: 'num' }, String(codexN))),
            h('tr', {}, h('td', {}, 'To read'), h('td', { class: 'num' }, `${mib(sel.bytes)} MiB, about ${sel.estimateSec} s`)),
            h('tr', {}, h('td', {}, 'Left out'), h('td', { class: 'num' }, `${sel.excluded.tooOld} older · ${sel.excluded.subagent} subagent threads · ${sel.excluded.overPerAgent} beyond the per-agent limit`)),
          ),
          sel.overSoftBound && h('p', { class: 'mt-warn' }, `This run is ${mib(sel.bytes)} MiB, over the 128 MiB guide. Every file is still read in full; it may take about ${sel.estimateSec} seconds. You can cancel at any time.`),
          h('button', { class: 'primary', disabled: sel.chosen.length === 0, onclick: () => void startRun(sel.chosen.map((c) => ({ rel: c.rel, blob: c.file, agent: c.agent }))) }, sel.overSoftBound ? 'Continue anyway' : 'Start the run'),
        ),
    ],
  );
}

function viewReading(): HTMLElement {
  const p = S.progress;
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
  return material(
    'mt-reading',
    [h('h1', {}, S.mode === 'sample' ? 'Reading the synthetic sample' : 'Reading your sessions'), h('p', { class: 'mt-sub' }, 'Cancel keeps the sessions already read and drops the one in progress.')],
    [
      h(
        'div',
        { class: 'mt-slip mt-run' },
        p
          ? h(
              'div',
              {},
              h('p', { class: 'mono' }, `File ${p.fileIndex} of ${p.files} · ${p.file}`),
              h('p', { class: 'num' }, `This file ${mib(p.fileBytes)} of ${mib(p.fileSize)} MiB`),
              h('div', { class: 'bar' }, h('i', { style: `width:${pct(p.fileBytes, p.fileSize)}%` })),
              h('p', { class: 'num' }, `Overall ${mib(p.bytesDone)} of ${mib(p.bytesTotal)} MiB · ${p.sessionsDone} of ${p.files} sessions read`),
              h('div', { class: 'bar' }, h('i', { style: `width:${pct(p.bytesDone, p.bytesTotal)}%` })),
            )
          : h('p', {}, 'Starting…'),
        h('div', { class: 'row' }, h('button', { onclick: () => cancelRead() }, 'Cancel')),
      ),
    ],
  );
}

function nodeLabel(A: Analysis, n: RouteNode): string {
  const names = n.rooms.map((k) => A.rooms.find((r) => r.key === k)?.name).filter((x): x is string => !!x);
  switch (n.kind) {
    case 'encounter':
    case 'elite':
      return `${n.kind === 'elite' ? 'Elite' : 'Encounter'} · ${names[0] ?? ''}`;
    case 'event':
      return 'Event · A change of plan';
    case 'review':
      return `Review · ${names.join(', ')}`;
    case 'workshop':
      return 'Workshop · a verified workflow';
    case 'card-review':
      return 'Your existing rules';
    case 'campfire':
      return 'Campfire · make room';
    case 'boss':
      return `Later cases · ${n.rooms.reduce((a, k) => a + (A.rooms.find((r) => r.key === k)?.withheld.length ?? 0), 0)} held for the boss`;
    case 'audit':
      return 'Final audit';
    case 'apply':
      return 'Apply';
  }
}

/** The hand mirror: the Trait card's emblem (decoration only). */
function mirrorEmblem(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 32 44');
  s.setAttribute('aria-hidden', 'true');
  for (const d of ['M16 2a11 11 0 1 1 0 22 11 11 0 0 1 0-22Z', 'M16 6.5a6.5 6.5 0 0 0-6.2 4.6', 'M16 24v8M13 32h6l-1.2 9.5h-3.6Z']) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

/** The character card in the fixed L box: the name from the fixed table, the counts as its line (§8). */
function characterCard(c: NonNullable<Analysis['mirror']['character']>, total: number): HTMLElement {
  return h(
    'div',
    { class: 'mt-char', role: 'img', 'aria-label': `The sampled build: ${c.name}. ${c.line}. Seen in ${c.evidenceSessions} of ${total} sessions.` },
    h('div', { class: 'mt-char-top' }, h('span', {}, 'The sampled build'), h('span', {}, 'Trait')),
    h('div', { class: 'mt-char-art' }, mirrorEmblem()),
    h('p', { class: 'mt-char-name' }, c.name),
    h('p', { class: 'mt-char-line' }, c.line),
    h('div', { class: 'mt-char-foot' }, `seen in ${c.evidenceSessions} of ${total} sessions`),
  );
}

function viewMirror(): HTMLElement {
  const A = S.A!;
  const m = A.mirror;
  const read = S.read;
  return material(
    'mt-mirror',
    [
      h('h1', {}, S.mode === 'sample' ? 'What the synthetic sample shows' : 'What your sessions show'),
      // One line saying what the page is, then the way on at the top (P3 gate fix E).
      h('p', { class: 'mt-sub' }, 'Counts from the sessions, before any play. Nothing here is a problem until you stamp it.'),
      h('button', { class: 'primary mt-start', onclick: () => startPlayLoop() }, 'Start the act'),
    ],
    [
      h(
        'div',
        { class: 'mt-row' },
        m.character ? characterCard(m.character, m.sessions.total) : h('p', { class: 'mt-slip' }, 'Not enough evidence for a character card yet.'),
        h(
          'div',
          { class: 'mt-slip mt-act tilt-b' },
          h('h2', {}, 'The act'),
          h('p', { class: 'mt-note' }, actLine(A)),
          h('ol', {}, ...A.route.nodes.map((n) => h('li', {}, nodeLabel(A, n)))),
          read && h('p', { class: 'mt-note' }, `Read ${mib(read.bytes)} MiB in ${(read.ms / 1000).toFixed(1)} s${read.cancelled ? ' · cancelled, partial run' : ''}${read.failed ? ` · ${read.failed} files could not be read` : ''}`),
        ),
      ),
      h('dl', { class: 'mt-counts' }, ...mirrorRows(m).map(([k, v], i) => h('div', { class: `mt-slip mt-count ${['tilt-a', 'tilt-b', 'tilt-c', ''][i % 4]}` }, h('dt', {}, k), h('dd', {}, v)))),
      S.mode === 'real' && !S.dirs.codexLoaded && hasFSA && h('div', { class: 'mt-slip mt-privacy' }, h('p', {}, 'Optional: load AGENTS.md now so its weight and any disagreements show during the act. Read only; write access is asked at Apply.'), h('button', { onclick: () => void readCodexHome() }, 'Choose ~/.codex')),
    ],
  );
}

// Renders are deferred and never nested: a blur fired while the DOM is being replaced must not re-enter.
let scheduled = false;
function render(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    paint();
  });
}

function paint(): void {
  // The play loop owns #app while it runs.
  if (S.step === 'play') return;
  document.body.classList.remove('is-play');
  const view = S.step === 'import' ? viewImport() : S.step === 'reading' ? viewReading() : viewMirror();
  const wood = view.querySelector('.mt-wood');
  if (wood && (S.error || S.busy)) wood.prepend(h('p', { class: `mt-slip mt-privacy${S.error ? ' mt-warn' : ''}`, role: 'status' }, S.error ?? S.busy ?? ''));
  app.replaceChildren(view);
}

render();
// "#play-ui" (the game) and "#play" (the debug render) open the play loop on the synthetic sample at once.
if (hash() === '#play' || hash() === '#play-ui') void startSample();
