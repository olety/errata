// The app: Import → Reading → Mirror → the play loop (rooms, campfires, boss, Apply, Undo). The import, reading and
// mirror pages are plain; the play loop owns #app once it starts. Every string from a log is set with textContent,
// never parsed as HTML. Routes: /errata/ is the game; "#play-ui" starts the sample straight into the play loop;
// "#play" opens the plain debug render of every view field.

import './style.css';
import type { Agent } from '../model';
import { analyse, type Analysis } from '../pipeline';
import type { RouteNode } from '../rooms';
import { newDeck, type DeckState } from '../deck/deck';
import { CODEX_OVERRIDE } from '../deck/lanes';
import { ensureWritable, fsaRoot, prefixedRoot } from '../apply/fsa-root';
import type { Root } from '../apply/types';
import { NEGATIVE_LABELS, type NegativeKind } from '../noise';
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
    S.deck = newDeck(claude, await readIn(dir, 'AGENTS.md'), await readIn(dir, CODEX_OVERRIDE));
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

// ---------------------------------------------------------------- pages: import, reading, mirror
function steps(): HTMLElement {
  const names: [Step, string][] = [
    ['import', 'Import'],
    ['reading', 'Reading'],
    ['mirror', 'Mirror'],
    ['play', 'The act'],
  ];
  return h('nav', { class: 'steps' }, h('span', { class: 'brand' }, 'Errata'), S.mode === 'sample' ? h('span', { class: 'chip' }, SAMPLE_LABEL) : null, ...names.map(([k, n]) => h('span', { class: S.step === k ? 'on' : '' }, n)));
}

function viewImport(): HTMLElement {
  const sel = S.selection;
  const drop = h('div', { class: 'drop' }, 'Or drop .jsonl session files here.');
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
  return h(
    'section',
    {},
    h('h1', {}, 'Your rules file is a deck.'),
    h('p', { class: 'sub' }, 'Read your recent Claude Code and Codex sessions, review what happened, and write better rules into CLAUDE.md and AGENTS.md. Everything stays in this tab.'),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', onclick: () => void startSample() }, 'Play the synthetic sample'),
      hasFSA && h('button', { onclick: () => void pickClaude() }, 'Choose your ~/.claude folder'),
      hasFSA && h('button', { onclick: () => void pickCodexSessions() }, 'Choose ~/.codex/sessions'),
    ),
    !hasFSA && h('p', { class: 'sub' }, 'This browser cannot open folders. Drop session files instead.'),
    drop,
    h('p', { class: 'sub' }, 'Only projects/**/*.jsonl under ~/.claude and rollout-*.jsonl under ~/.codex/sessions are read, each file in full. Secrets are redacted as each line is parsed.'),
    sel &&
      h(
        'div',
        {},
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
        sel.overSoftBound && h('p', { class: 'warn' }, `This run is ${mib(sel.bytes)} MiB, over the 128 MiB guide. Every file is still read in full; it may take about ${sel.estimateSec} seconds. You can cancel at any time.`),
        h('button', { class: 'primary', disabled: sel.chosen.length === 0, onclick: () => void startRun(sel.chosen.map((c) => ({ rel: c.rel, blob: c.file, agent: c.agent }))) }, sel.overSoftBound ? 'Continue anyway' : 'Start the run'),
      ),
  );
}

function viewReading(): HTMLElement {
  const p = S.progress;
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
  return h(
    'section',
    {},
    h('h1', {}, S.mode === 'sample' ? 'Reading the synthetic sample' : 'Reading your sessions'),
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
      : h('p', { class: 'sub' }, 'Starting…'),
    h('div', { class: 'row' }, h('button', { onclick: () => cancelRead() }, 'Cancel')),
    h('p', { class: 'sub' }, 'Cancel keeps the sessions already read and drops the one in progress.'),
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
      return `Later cases · ${n.rooms.reduce((a, k) => a + (A.rooms.find((r) => r.key === k)?.withheld.length ?? 0), 0)} held back until the end`;
    case 'audit':
      return 'Final audit';
    case 'apply':
      return 'Apply';
  }
}

function viewMirror(): HTMLElement {
  const A = S.A!;
  const m = A.mirror;
  const neg = (Object.entries(m.negatives) as [NegativeKind, number][]).filter(([, v]) => v > 0);
  const rows: [string, string][] = [
    ['Sessions', `${m.sessions.total} (Claude Code ${m.sessions.claude}, Codex ${m.sessions.codex}) · ${m.dates.from ?? '–'} to ${m.dates.to ?? '–'}`],
    ['Projects', `${m.projects.total} (sessions with a project: ${m.projects.sessionsWithProject} of ${m.sessions.total})`],
    ['Partial sessions', `${m.sessions.partial} of ${m.sessions.total}`],
    ['Your messages', String(m.humanTurns)],
    ['Excluded system text', `${m.excluded.total} turns that were not you typing (${Object.entries(m.excluded.byKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`],
    ['Stops followed by your next message', `${m.interventions.total} of ${m.interrupts} stops · ${m.interventions.lines} drew a line · ${m.interventions.pivots} changed the plan · ${m.interventions.other} other`],
    ['Same command failing again unchanged', `${m.repeatedCommand.episodes} in ${m.repeatedCommand.sessionsWith} of ${m.sessions.total} sessions`],
    ['Failed shell runs', `${m.repeatedCommand.genuineFailures} of ${m.repeatedCommand.shellCalls}`],
    ['Looked like failures, were not', neg.length ? neg.map(([k, v]) => `${v} ${NEGATIVE_LABELS[k]}`).join(' · ') : 'none'],
    ['Edit sequences (3+ edits to one file)', `${m.editSequences.candidates} candidates in ${m.editSequences.sessionsWith} of ${m.sessions.total} sessions · ${m.editSequences.promoted} with a stop on them`],
    ['The same instruction in several sessions', `${m.directives.repeated}`],
    ['Check → diff → report workflow', `${m.workflows.occurrences} times in ${m.workflows.sessions} of ${m.sessions.total} sessions${m.workflows.verified ? ' · verified' : ''}`],
    ['Tool calls with a recorded result', `${m.calls.withResult} of ${m.calls.total}`],
    ['Top tools', m.topTools.map(([n, c]) => `${n} ${c}`).join(', ')],
    ['Secrets redacted while reading', String(m.redactions)],
  ];
  const read = S.read;
  return h(
    'section',
    {},
    h('h1', {}, S.mode === 'sample' ? 'What the synthetic sample shows' : 'What your sessions show'),
    h('p', { class: 'sub' }, 'Counts only. Nothing below is a problem until you say so.'),
    read && h('p', { class: 'num sub' }, `Read ${mib(read.bytes)} MiB in ${(read.ms / 1000).toFixed(1)} s${read.cancelled ? ' · cancelled, partial run' : ''}${read.failed ? ` · ${read.failed} files could not be read` : ''}`),
    m.character
      ? h('div', { class: 'character' }, h('p', { class: 'sub' }, 'The sampled build'), h('h2', {}, m.character.name), h('p', {}, m.character.line))
      : h('p', { class: 'sub' }, 'Not enough evidence for a character card yet.'),
    h('table', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, v)))),
    h('h2', {}, 'The act'),
    h('ol', { class: 'route' }, ...A.route.nodes.map((n) => h('li', {}, nodeLabel(A, n)))),
    h('p', { class: 'sub' }, `${A.rooms.length} rooms found; ${A.route.leftovers.length} more stay off this act.`),
    S.mode === 'real' && !S.dirs.codexLoaded && hasFSA && h('div', { class: 'row' }, h('span', { class: 'sub' }, 'Optional: load AGENTS.md now so its weight and any disagreements show during the act. Read only; write access is asked at Apply.'), h('button', { onclick: () => void readCodexHome() }, 'Choose ~/.codex')),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => startPlayLoop() }, 'Start the act')),
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
  app.replaceChildren(h('div', { class: 'page' }, steps(), S.error ? h('p', { class: 'warn' }, S.error) : '', S.busy ? h('p', { class: 'sub' }, S.busy) : '', view));
}

render();
// "#play-ui" (the game) and "#play" (the debug render) open the play loop on the synthetic sample at once.
if (hash() === '#play' || hash() === '#play-ui') void startSample();
