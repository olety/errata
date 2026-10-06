// The app: Import → mirror → the linear act (rooms, campfires, boss or audit) → Diff → Apply → receipt → Undo.
// Plain and functional on purpose; the final material is co-designed elsewhere. Every string from a log is set with
// textContent (inline code becomes <code> spans built as elements), never parsed as HTML.

import './style.css';
import type { Agent, Session, Turn } from '../model';
import type { Episode } from '../episodes';
import { analyse, type Analysis } from '../pipeline';
import { caseFor, Dispositions, splitByProject, buildRoute, type Room, type RouteNode } from '../rooms';
import { draftCards, proposedScope } from '../deck/templates';
import { acceptMapping, updateCard } from '../deck/card';
import { playCard, withProposed } from '../play';
import type { Card, Case, Disposition, Targets } from '../deck/types';
import { CODEX_OVERRIDE, type LaneResult } from '../deck/lanes';
import { sanitizeLine, text as utf8, weigh } from '../deck/file';
import { lineDiff, renderDiff } from '../deck/diff';
import { cover, coverage, CHECKS } from '../cover';
import { acceptImportMapping, deckExportMap, newDeck, presentCards, rebaseDeck, renderLanes, withCards, type DeckState } from '../deck/deck';
import { applyFuse, conflicts, cutCard, fuseSuggestions, previewChange, previewFuse, resolveConflict, sharpen, sharpenSuggestions, type Conflict, type FuseSuggestion } from '../deck/campfire';
import { applyTargets, type ApplyTargets } from '../deck/skill-plan';
import { applyPlan, makePlan, restoreOriginalSeen, undoBundle } from '../apply/engine';
import { ensureWritable, fsaRoot, prefixedRoot } from '../apply/fsa-root';
import type { ApplyResult, Plan, Root, UndoResult } from '../apply/types';
import { claudeCandidates, codexCandidates, droppedCandidates, selectRun, type Candidate, type Selection } from './importer';
import { resetSample, sampleDirs, sampleFiles, SAMPLE_LABEL } from './sample';
import type { ParseReply, ParseRequest } from './worker';
import { NEGATIVE_LABELS, type NegativeKind } from '../noise';
import { createPlayState, type ApplyPort } from './playloop/adapter';
import { Controller } from './playloop/controller';
import { mountDebug } from './playloop/debug';
import { mountScreens } from './playloop/mount';

type Step = 'import' | 'reading' | 'mirror' | 'act' | 'receipt' | 'play';

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
  rooms: Room[];
  route: RouteNode[];
  node: number;
  sub: number;
  disp: Dispositions;
  remember: boolean;
  /** Player-confirmed wording per room key (boundary and directive families). */
  wording: Map<string, string>;
  deck: DeckState;
  /** Edited drafts until taken, keyed by draft id. */
  edited: Map<string, Card>;
  editing: string | null;
  inspect: boolean;
  campfireText: Map<string, string>;
  dirs: { claude: FileSystemDirectoryHandle | null; codex: FileSystemDirectoryHandle | null; agents: FileSystemDirectoryHandle | null; codexLoaded: boolean; claudeLoaded: boolean };
  roots: Root[] | null;
  targets: ApplyTargets | null;
  plan: Plan | null;
  result: ApplyResult | null;
  undo: UndoResult | null;
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
  rooms: [],
  route: [],
  node: 0,
  sub: 0,
  disp: new Dispositions(),
  remember: false,
  wording: new Map(),
  deck: newDeck(null, null),
  edited: new Map(),
  editing: null,
  inspect: false,
  campfireText: new Map(),
  dirs: { claude: null, codex: null, agents: null, codexLoaded: false, claudeLoaded: false },
  roots: null,
  targets: null,
  plan: null,
  result: null,
  undo: null,
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
    else if (k === 'checked') (el as HTMLInputElement).checked = Boolean(v);
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

/** Text with `inline code` rendered as <code> spans (built as elements, never parsed as HTML). */
export function rich(text: string): DocumentFragment {
  const f = document.createDocumentFragment();
  const parts = text.split(/(`[^`\n]+`)/g);
  for (const p of parts) {
    if (!p) continue;
    if (p.length > 2 && p.startsWith('`') && p.endsWith('`')) f.append(h('code', {}, p.slice(1, -1)));
    else f.append(document.createTextNode(p));
  }
  return f;
}

const app = document.getElementById('app')!;
const hasFSA = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
const pick = (o: object) => (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker(o);
const mib = (b: number) => (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0);
const agentName = (a: Agent) => (a === 'claude' ? 'Claude Code' : 'Codex');
const targetsName = (t: Targets) => (t === 'both' ? 'Claude + Codex' : t === 'claude' ? 'Claude only' : 'Codex only');

function set(p: Partial<State>): void {
  Object.assign(S, p);
  render();
}

function fail(e: unknown): void {
  set({ busy: null, error: String((e as Error)?.message ?? e) });
}

// ---------------------------------------------------------------- persistence (opt-in, this device only)
const STORE = 'deck:dispositions:v1';
function loadRemembered(): void {
  try {
    S.remember = localStorage.getItem('deck:remember') === '1';
    if (S.remember) S.disp = Dispositions.fromJSON(JSON.parse(localStorage.getItem(STORE) ?? 'null'));
  } catch {
    S.remember = false;
  }
}
function persist(): void {
  try {
    localStorage.setItem('deck:remember', S.remember ? '1' : '0');
    if (S.remember) localStorage.setItem(STORE, JSON.stringify(S.disp));
    else localStorage.removeItem(STORE);
  } catch {
    /* storage unavailable: reviews stay in this tab */
  }
}
function dispose(ids: string[], d: Disposition): void {
  for (const id of ids) S.disp.set(id, d);
  persist();
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
    rebuild(analyse(done.sessions, { episodes: done.episodes, importedCards: S.deck.imported.length, dispositions: S.disp }));
    set({ step: 'mirror', node: 0, sub: 0 });
    if (location.hash === '#play' || location.hash === '#play-ui') startPlayLoop();
  } catch (e) {
    set({ step: 'import' });
    fail(e);
  }
}

function rebuild(A: Analysis): void {
  S.A = A;
  S.rooms = A.rooms;
  S.route = A.route.nodes;
}

async function startSample(): Promise<void> {
  try {
    S.mode = 'sample';
    S.candidates = [];
    set({ busy: 'Loading the synthetic sample…', error: null });
    const dirs = await sampleDirs();
    S.dirs = { claude: dirs.claude, codex: dirs.codex, agents: dirs.agents, claudeLoaded: true, codexLoaded: true };
    S.roots = null;
    S.busy = null;
    await startRun(await sampleFiles());
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------- the act
function roomByKey(k: string): Room | undefined {
  return S.rooms.find((r) => r.key === k);
}
const currentNode = () => S.route[S.node];

function nextNode(): void {
  const n = currentNode();
  if (n && n.rooms.length > 1 && S.sub < n.rooms.length - 1 && (n.kind === 'review' || n.kind === 'workshop')) {
    set({ sub: S.sub + 1, editing: null, inspect: false });
    return;
  }
  set({ node: Math.min(S.node + 1, S.route.length - 1), sub: 0, editing: null, inspect: false });
  if (currentNode()?.kind === 'apply') void prepareDiff();
}

function cardsFor(r: Room): Card[] {
  const w = S.wording.get(r.key);
  return draftCards(r, w !== undefined ? { wording: w } : {});
}

function roomCases(r: Room, withWithheld = false): Case[] {
  const eps = withWithheld ? [...r.episodes, ...r.withheld] : r.episodes;
  return eps.map((e) => ({ ...caseFor(e, r), disposition: S.disp.get(e.id) }));
}

/**
 * Taking a card never stamps a case (play-loop §14.3): dispositions come only from the per-case stamps. The play goes
 * through the engine, which accepts the mapping only for stamped heads the card is eligible for and reports the true
 * cover results. A verified workflow is a success, not an issue: its card joins the proposal with no case accepted.
 */
function takeCard(r: Room, card: Card): void {
  if (r.family === 'workflow') {
    S.deck = withProposed(S.deck, card, card.targets);
    nextNode();
    return;
  }
  const res = playCard(S.deck, card, roomCases(r), 'beast');
  if (res.refused) {
    set({ error: res.refused });
    return;
  }
  S.deck = res.deck;
  S.error = null;
  nextNode();
}

function splitRoom(r: Room, projectKey: string | null): void {
  const parts = splitByProject(r, projectKey);
  S.rooms = [...S.rooms.filter((x) => x !== r), ...parts];
  S.route = buildRoute(S.rooms, { importedCards: S.deck.imported.length }).nodes;
  // Stay on the part the player confirmed.
  const mine = parts[0];
  const idx = S.route.findIndex((n) => mine && n.rooms.includes(mine.key));
  set({ node: idx >= 0 ? idx : S.node, sub: 0 });
}

/** All reviewed cases on the route (withheld included once reviewed at the boss). */
function reviewedCases(): Case[] {
  const out: Case[] = [];
  for (const r of S.rooms) for (const c of roomCases(r, true)) if (c.disposition !== 'unreviewed') out.push(c);
  return out;
}

// ---------------------------------------------------------------- lanes, diff, apply
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

async function grant(which: 'claude' | 'codex' | 'agents', mode: 'read' | 'readwrite' = 'readwrite'): Promise<void> {
  try {
    const dir = await pick({ id: `${which}-home`, mode });
    S.dirs[which] = dir;
    S.roots = null;
    if (which === 'claude' || which === 'codex') {
      if (which === 'codex') S.dirs.codexLoaded = true;
      else S.dirs.claudeLoaded = true;
      const claude = S.dirs.claude ? await readIn(S.dirs.claude, 'CLAUDE.md') : null;
      const codex = S.dirs.codex ? await readIn(S.dirs.codex, 'AGENTS.md') : null;
      const override = S.dirs.codex ? await readIn(S.dirs.codex, CODEX_OVERRIDE) : null;
      // Taken cards, campfire edits to lines that still exist and resolved red links carry over.
      S.deck = rebaseDeck(S.deck, claude, codex, override);
    }
    if (currentNode()?.kind === 'apply') await prepareDiff();
    else render();
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') fail(e);
  }
}

async function prepareDiff(): Promise<void> {
  try {
    const roots = rootsFor();
    if (!roots || !S.dirs.claudeLoaded || !S.dirs.codexLoaded) {
      set({ plan: null, targets: null });
      return;
    }
    const byId = new Map(roots.map((r) => [r.id, r]));
    const legacy = S.dirs.codex ? prefixedRoot(fsaRoot('codex', S.dirs.codex, 'codex'), 'codex', 'skills', '~/.codex/skills') : null;
    const read = (root: 'claude-skills' | 'codex-skills' | 'codex-legacy-skills', rel: string) => (root === 'codex-legacy-skills' ? (legacy ? legacy.read(rel) : Promise.resolve(null)) : byId.get(root)?.read(rel) ?? Promise.resolve(null));
    const t = await applyTargets(S.deck, S.rooms, { claude: true, codex: !!S.dirs.agents }, read);
    const plan = t.problems.length ? null : await makePlan(roots, t.targets);
    set({ targets: t, plan, result: null, undo: null });
  } catch (e) {
    fail(e);
  }
}

async function doApply(): Promise<void> {
  if (!S.plan || !S.roots) return;
  try {
    if (S.mode === 'real') {
      const ok = (await ensureWritable(S.dirs.claude!)) && (await ensureWritable(S.dirs.codex!)) && (!S.dirs.agents || (await ensureWritable(S.dirs.agents)));
      if (!ok) throw new Error('Write access was not granted.');
    }
    set({ busy: 'Writing and reading back…', error: null });
    const result = await applyPlan(S.plan, S.roots, S.plan.digest);
    set({ busy: null, result, step: 'receipt' });
  } catch (e) {
    fail(e);
  }
}

function bundleOf(r: ApplyResult | null): string | null {
  return r?.status === 'written' ? r.receipt.bundleId : r?.status === 'partial' ? r.bundleId : null;
}

async function doUndo(): Promise<void> {
  const id = bundleOf(S.result);
  if (!id || !S.roots) return;
  set({ busy: 'Restoring…' });
  set({ busy: null, undo: await undoBundle(id, S.roots) });
}

async function forceRestore(rel: string, root: Root['id'], seenSha: string | null): Promise<void> {
  const id = bundleOf(S.result);
  if (!id || !S.roots) return;
  const res = await restoreOriginalSeen(id, S.roots, { root, rel }, seenSha);
  if (S.undo?.status === 'done') S.undo = { status: 'done', files: S.undo.files.map((f) => (f.rel === rel && f.root === root ? res : f)) };
  render();
}

// ---------------------------------------------------------------- the play loop (debug render until the workers land)
/** The play loop writes through the same roots and grants as the slice; the engine's write protocol does the rest. */
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
  const state = createPlayState({ analysis: S.A, deck: S.deck, sample: S.mode === 'sample', loaded: { claude: S.dirs.claudeLoaded, codex: S.dirs.codexLoaded }, disp: S.disp.toJSON().dispositions });
  const ctl = new Controller(state, playPort(), { viewport: { w: window.innerWidth, h: window.innerHeight }, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  S.step = 'play';
  unmountPlay?.();
  // "#play-ui" composes the workers' components; "#play" and the mirror button use the plain debug render.
  unmountPlay = location.hash === '#play-ui' ? mountScreens(app, ctl) : mountDebug(app, ctl);
}

// ---------------------------------------------------------------- views: import and reading
function steps(): HTMLElement {
  const names: [Step, string][] = [
    ['import', 'Import'],
    ['reading', 'Reading'],
    ['mirror', 'Mirror'],
    ['act', 'The act'],
    ['receipt', 'Receipt'],
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
    !hasFSA && h('p', { class: 'sub' }, 'This browser cannot open folders. Drop session files instead; Apply will offer an exported bundle.'),
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

// ---------------------------------------------------------------- views: mirror
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
    ['Cases you confirmed as issues', String([...S.rooms.flatMap((r) => [...r.episodes, ...r.withheld])].filter((e) => S.disp.get(e.id) === 'issue').length)],
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
    h('ol', { class: 'route' }, ...S.route.map((n) => h('li', {}, nodeLabel(n)))),
    h('p', { class: 'sub' }, `${S.rooms.length} rooms found; ${A.route.leftovers.length} more stay off this act.`),
    h(
      'label',
      { class: 'row' },
      h('input', {
        type: 'checkbox',
        checked: S.remember,
        onchange: (e: Event) => {
          S.remember = (e.target as HTMLInputElement).checked;
          persist();
        },
      }),
      'Remember my reviews on this device (stored only in this browser).',
    ),
    S.mode === 'real' && !S.dirs.codexLoaded && hasFSA && h('div', { class: 'row' }, h('span', { class: 'sub' }, 'Optional: load AGENTS.md now so its weight and any disagreements show during the act. Read only; write access is asked at Apply.'), h('button', { onclick: () => void grant('codex', 'read') }, 'Choose ~/.codex')),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => set({ step: 'act', node: 0, sub: 0 }) }, 'Start the act'), h('button', { onclick: () => startPlayLoop() }, 'Play loop (preview)')),
  );
}

function nodeLabel(n: RouteNode): string {
  const r = n.rooms.map(roomByKey).filter((x): x is Room => !!x);
  switch (n.kind) {
    case 'encounter':
    case 'elite':
      return `${n.kind === 'elite' ? 'Elite' : 'Encounter'} · ${r[0]?.name ?? ''}`;
    case 'event':
      return 'Event · A change of plan';
    case 'review':
      return `Review · ${r.map((x) => x.name).join(', ')}`;
    case 'workshop':
      return 'Workshop · a verified workflow';
    case 'card-review':
      return 'Your existing rules';
    case 'campfire':
      return 'Campfire · make room';
    case 'boss':
      return `Boss · ${r.reduce((a, x) => a + x.withheld.length, 0)} later cases replayed`;
    case 'audit':
      return 'Final audit';
    case 'apply':
      return 'Apply';
  }
}

// ---------------------------------------------------------------- views: rooms
function sessionOf(id: string): Session | undefined {
  return S.A?.sessions.find((s) => s.id === id);
}

function viewInspect(e: Episode): HTMLElement {
  const s = sessionOf(e.sessionId);
  if (!s) return h('p', {}, 'Source not loaded.');
  const from = Math.max(0, e.turn - 3);
  const to = Math.min(s.turns.length, e.turn + 5);
  const line = (t: Turn) =>
    h(
      'div',
      { class: 'turn' },
      h('b', {}, `${t.i} ${t.role}${t.injected ? `:${t.injected}` : ''}${t.interrupt ? `:${t.interrupt}` : ''} `),
      t.text.slice(0, 300),
      ...t.calls.slice(-4).map((c) => h('div', { class: 'mono sub' }, `→ ${c.name} ${c.command ?? c.files.join(', ')} · ${c.result ? `${c.result.status}${c.result.exitCode !== null ? ` exit ${c.result.exitCode}` : ''}${c.result.negative ? ` · ${NEGATIVE_LABELS[c.result.negative]}` : ''}` : 'no result'}`)),
    );
  return h('div', {}, h('p', { class: 'sub' }, `${agentName(s.agent)} · ${s.file} · ${s.startedAt?.slice(0, 16) ?? ''}`), ...s.turns.slice(from, to).map(line));
}

function receipt(e: Episode, r: Room): HTMLElement {
  const quote = e.receipt.quote;
  return h(
    'div',
    { class: 'receipt' },
    h('p', { class: 'quote' }, quote ? `“${quote}”` : 'Tool evidence only'),
    e.type === 'interrupt' && e.pasted && h('p', { class: 'sub' }, 'This looks like pasted text, shortened.'),
    h('p', { class: 'mono sub' }, `Action: ${e.receipt.action ?? 'none recorded'}`),
    h('p', { class: 'mono sub' }, `Result: ${e.receipt.result ?? 'none recorded'}`),
    e.receipt.then && h('p', { class: 'mono sub' }, `Then: ${e.receipt.then}`),
    h('p', { class: 'sub' }, `${agentName(e.agent)}${e.projectLabel ? ` · ${e.projectLabel}` : ''} · ${e.ts?.slice(0, 10) ?? ''} · supporting sessions: ${r.sessions}${r.withheld.length ? ` · ${r.withheld.length} later cases kept for the boss` : ''}`),
  );
}

function cardView(card: Card, r: Room | null, onTake: (() => void) | null): HTMLElement {
  const taken = S.deck.cards.some((t) => t.id === card.id);
  const editing = S.editing === card.id;
  const ta = h('textarea', { rows: 3 }, card.text) as HTMLTextAreaElement;
  const sel = h(
    'select',
    {},
    ...(['both', 'claude', 'codex'] as const).map((t) => {
      const o = h('option', { value: t }, targetsName(t));
      if (card.targets === t) o.selected = true;
      return o;
    }),
  ) as HTMLSelectElement;
  return h(
    'div',
    { class: `card${taken ? ' taken' : ''}` },
    h('h3', {}, card.title),
    editing ? ta : h('p', {}, rich(card.text)),
    editing && sel,
    h(
      'div',
      { class: 'chips' },
      h('span', { class: 'chip' }, targetsName(card.targets)),
      h('span', { class: 'chip' }, card.scope.kind === 'global' ? 'all projects' : card.scope.label),
      h('span', { class: 'chip' }, card.type === 'skill' ? `Skill · ${card.skillSlug}` : card.type),
      h('span', { class: 'chip mono' }, `~${Math.ceil((new TextEncoder().encode(card.text).length + 24) / 3)} tok`),
      r && h('span', { class: 'chip' }, r.family === 'workflow' ? 'Verified workflow' : r.sessions > 1 ? 'Repeated' : 'Observed'),
    ),
    editing && h('p', { class: 'sub' }, 'An edited card needs your mapping approval again.'),
    h(
      'div',
      { class: 'row' },
      editing
        ? h(
            'button',
            {
              onclick: () => {
                const next = updateCard(card, { text: ta.value, targets: sel.value as Targets }, sanitizeLine);
                S.edited.set(card.id, next);
                set({ editing: null });
              },
            },
            'Done',
          )
        : onTake && h('button', { class: 'primary', onclick: onTake }, 'Take'),
      !editing && onTake && h('button', { onclick: () => set({ editing: card.id }) }, 'Edit'),
    ),
  );
}

function viewRoom(r: Room): HTMLElement {
  const e = r.anchor;
  const drafts = cardsFor(r).map((c) => S.edited.get(c.id) ?? c);
  const wordingInput = h('input', { type: 'text', value: S.wording.get(r.key) ?? r.proposedConstraint ?? '', placeholder: 'The line, in your words' }) as HTMLInputElement;
  wordingInput.addEventListener('change', () => {
    S.wording.set(r.key, wordingInput.value);
    render();
  });
  const others = r.episodes.filter((x) => x !== e);
  const scope = proposedScope(r);
  if (r.kind === 'event') {
    return h(
      'section',
      {},
      h('h1', {}, r.name),
      h('p', { class: 'sub' }, r.subtitle),
      receipt(e, r),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'primary', onclick: () => (dispose([e.id], 'pivot'), nextNode()) }, 'Yes, a change of plan'),
        h('button', { onclick: () => (dispose([e.id], 'unclear'), nextNode()) }, 'Unclear'),
        h('button', { onclick: () => (dispose([e.id], 'issue'), nextNode()) }, 'No, the agent crossed a line'),
        h('button', { onclick: () => set({ inspect: !S.inspect }) }, S.inspect ? 'Hide source' : 'Inspect source'),
      ),
      h('p', { class: 'sub' }, 'A change of plan is never a monster and never becomes a rule.'),
      S.inspect && viewInspect(e),
      meters(),
    );
  }
  return h(
    'section',
    {},
    h('h1', {}, r.name),
    h('p', { class: 'sub' }, rich(r.subtitle)),
    receipt(e, r),
    h(
      'div',
      { class: 'stamps' },
      h('p', { class: 'sub' }, 'Stamp each case. Only a case stamped a problem can be addressed by a card.'),
      ...[e, ...others].map((o) =>
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'mono sub' }, `${agentName(o.agent)} · ${o.ts?.slice(0, 10) ?? ''} · ${o.receipt.quote ? `“${o.receipt.quote.slice(0, 120)}”` : o.receipt.action ?? ''}`),
          ...(
            [
              ['issue', 'A problem'],
              ...(o.type === 'interrupt' ? [['pivot', 'A change of plan'] as const] : []),
              ['not-a-problem', 'Not a problem'],
              ['unclear', 'Unclear'],
            ] as const
          ).map(([d, label]) => h('button', { class: S.disp.get(o.id) === d ? 'on' : '', onclick: () => (dispose([o.id], d), render()) }, label)),
        ),
      ),
    ),
    r.projects.length > 1 &&
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'sub' }, `Seen in ${r.projects.map((p) => p.label ?? 'no project').join(', ')}. Cards apply to all projects unless you pick one:`),
        ...r.projects.map((p) => h('button', { onclick: () => splitRoom(r, p.key) }, `Only ${p.label ?? 'no project'}`)),
      ),
    (r.family === 'boundary' || r.family === 'directive') && h('div', { class: 'row' }, wordingInput),
    h('div', { class: 'cards' }, ...drafts.map((c) => cardView(c, r, () => takeCard(r, c)))),
    h(
      'div',
      { class: 'row' },
      h('button', { onclick: () => nextNode() }, 'Skip'),
      h('button', { onclick: () => set({ inspect: !S.inspect }) }, S.inspect ? 'Hide source' : 'Inspect source'),
    ),
    h('p', { class: 'sub' }, scope.kind === 'project' ? `Cards here are scoped to ${scope.label}; the text says so.` : 'Cards here apply to all projects. Taking one approves that.'),
    S.inspect && viewInspect(e),
    meters(),
  );
}

function meters(): HTMLElement {
  const L = renderLanes(S.deck);
  const meter = (name: string, l: LaneResult, loaded: boolean) => {
    if (!loaded) return h('div', { class: 'meter' }, h('b', {}, name), h('div', { class: 'sub' }, 'Not loaded yet. It is read at the Apply step.'));
    const pct = Math.min(100, Math.round((l.after.total / l.allowance) * 100));
    return h(
      'div',
      { class: 'meter' },
      h('b', {}, name),
      h('span', { class: 'num' }, `  ${l.after.total} / ${l.allowance}`),
      l.noGrowth && h('span', { class: 'sub' }, ' · no-growth: already over the allowance'),
      l.blocker && h('span', { class: 'warn' }, ' · blocked'),
      h('div', { class: `bar${l.after.total > l.allowance ? ' over' : ''}` }, h('i', { style: `width:${pct}%` })),
    );
  };
  return h('div', { class: 'deck' }, meter('CLAUDE.md', L.claude, S.dirs.claudeLoaded), meter(L.codex.lane.rel, L.codex, S.dirs.codexLoaded));
}

// ---------------------------------------------------------------- views: campfire
function viewCampfire(): HTMLElement {
  const cases = reviewedCases();
  const present = presentCards(S.deck);
  const fuses = fuseSuggestions(S.deck);
  const reds = conflicts(S.deck);
  const sharp = sharpenSuggestions(S.deck, S.rooms.some((r) => r.family === 'workflow'));
  const L = renderLanes(S.deck);
  const over = L.claude.after.total > L.claude.allowance || L.codex.after.total > L.codex.allowance;
  const textOf = (id: string) => present.find((c) => c.id === id)?.text ?? id;
  const fuseView = (s: FuseSuggestion) => {
    const input = h('input', { type: 'text', value: S.campfireText.get(s.id) ?? s.autoText ?? '', placeholder: 'Write the merged line' }) as HTMLInputElement;
    input.addEventListener('change', () => (S.campfireText.set(s.id, input.value), render()));
    const text = S.campfireText.get(s.id) ?? s.autoText ?? '';
    const p = text ? previewFuse(S.deck, s, text, cases) : null;
    return h(
      'div',
      { class: 'card' },
      h('h3', {}, `Stack of ${s.members.length} · ${s.kind}`),
      h('p', { class: 'sub' }, s.why),
      ...s.members.map((id) => h('p', { class: 'mono del' }, `− ${textOf(id)}`)),
      s.autoText ? h('p', { class: 'mono add' }, rich(`+ ${text}`)) : h('p', { class: 'sub' }, 'The structured instructions differ; write the merged line yourself.'),
      input,
      p &&
        h(
          'p',
          { class: 'num sub' },
          `${targetsName(p.after!.targets)} · ${p.after!.scope.kind === 'global' ? 'all projects' : p.after!.scope.label}${p.after!.exceptions.length ? ` · exceptions: ${p.after!.exceptions.map((x) => x.text).join('; ')}` : ''} · CLAUDE.md ${p.weight.claude.before} → ${p.weight.claude.after} · AGENTS.md ${p.weight.codex.before} → ${p.weight.codex.after} · cases addressed ${p.cases.before} → ${p.cases.after}${p.cases.opened.length ? ` · reopens ${p.cases.opened.length}` : ''}`,
        ),
      h('button', { class: 'primary', disabled: !text, onclick: () => set({ deck: applyFuse(S.deck, s, text) }) }, 'Merge'),
    );
  };
  const redView = (c: Conflict) => {
    const projects = [...new Map(S.rooms.flatMap((r) => r.projects).filter((p) => p.key).map((p) => [p.key!, p.label ?? 'this project'])).entries()];
    const ex = h('input', { type: 'text', placeholder: 'e.g. unless the user names a test file' }) as HTMLInputElement;
    const except = (on: string) => {
      const t = ex.value.trim();
      if (t) set({ deck: resolveConflict(S.deck, c, { kind: 'exception', on, text: t, when: {} }) });
    };
    const short = (id: string) => {
      const t = textOf(id).replace(/`/g, '');
      return t.slice(0, 40) + (t.length > 40 ? '…' : '');
    };
    return h(
      'div',
      { class: 'card conflict' },
      h('h3', {}, 'These two disagree'),
      h('p', {}, rich(textOf(c.a))),
      h('p', {}, rich(textOf(c.b))),
      h('p', { class: 'sub' }, c.text),
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: () => set({ deck: resolveConflict(S.deck, c, { kind: 'keep', keep: c.a }) }) }, `Keep only “${short(c.a)}”`),
        h('button', { onclick: () => set({ deck: resolveConflict(S.deck, c, { kind: 'keep', keep: c.b }) }) }, `Keep only “${short(c.b)}”`),
        h('button', { onclick: () => set({ deck: resolveConflict(S.deck, c, { kind: 'cancel' }) }) }, 'Cancel'),
      ),
      projects.length > 0 &&
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'sub' }, 'Separate the conditions:'),
          ...[c.a, c.b].flatMap((bind) => projects.map(([key, label]) => h('button', { onclick: () => set({ deck: resolveConflict(S.deck, c, { kind: 'separate', bind, projectKey: key, projectLabel: label }) }) }, `“${short(bind)}” only in ${label}`))),
        ),
      h('div', { class: 'row' }, ex, h('button', { onclick: () => except(c.a) }, 'Add to the first'), h('button', { onclick: () => except(c.b) }, 'Add to the second')),
    );
  };
  return h(
    'section',
    {},
    h('h1', {}, 'Campfire'),
    h('p', { class: 'sub' }, 'Make room: merge, shorten, cut, or move a real procedure into a Skill.'),
    over && h('p', { class: 'warn' }, 'A file is over its allowance. Apply waits until it fits or you raise the allowance.'),
    reds.length > 0 && h('h2', {}, 'Red links'),
    ...reds.map(redView),
    fuses.length > 0 && h('h2', {}, 'Stacks'),
    h('div', { class: 'cards' }, ...fuses.map(fuseView)),
    sharp.length > 0 && h('h2', {}, 'Sharpen'),
    ...sharp.map((x) => h('div', { class: 'row' }, h('span', { class: 'mono' }, `${x.from} → ${x.to}`), h('button', { onclick: () => set({ deck: sharpen(S.deck, x.id, x.to) }) }, 'Sharpen'))),
    h('h2', {}, 'The deck'),
    h(
      'table',
      {},
      ...present.map((c) => {
        const cut = () => {
          const r = cutCard(S.deck, c.id, cases);
          set({ deck: r.deck, error: r.coverageLost.length ? `Cut: ${r.coverageLost.length} reviewed case${r.coverageLost.length === 1 ? '' : 's'} no longer addressed.` : null });
        };
        const p = previewChange(S.deck, cutCard(S.deck, c.id, cases).deck, cases);
        return h(
          'tr',
          {},
          h('td', {}, rich(c.text)),
          h('td', { class: 'num sub' }, `${targetsName(c.targets)} · ${c.family === 'imported' ? 'your rule' : c.type}`),
          h('td', { class: 'num sub' }, p.cases.opened.length ? `cut loses ${p.cases.opened.length}` : ''),
          h(
            'td',
            {},
            c.family === 'imported' && c.mappingSuggested && c.responseKey !== 'unmapped' && h('button', { onclick: () => set({ deck: acceptImportMapping(S.deck, c.id) }) }, `Accept: maps to ${c.responseKey.replace(/_/g, ' ')}`),
            h('button', { onclick: cut }, 'Cut'),
          ),
        );
      }),
    ),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => nextNode() }, 'Leave the campfire')),
    meters(),
  );
}

// ---------------------------------------------------------------- views: boss and audit
function viewBoss(n: RouteNode): HTMLElement {
  const rooms = n.rooms.map(roomByKey).filter((x): x is Room => !!x);
  const L = renderLanes(S.deck);
  const ex = deckExportMap(S.deck, L);
  const cards = presentCards(S.deck);
  const items = rooms.flatMap((r) => r.withheld.map((e) => ({ r, e })));
  let addressed = 0;
  const views = items.map(({ r, e }) => {
    const c: Case = { ...caseFor(e, r), disposition: S.disp.get(e.id) };
    const results = cards.map((k) => ({ k, res: cover(k, c, ex) }));
    const lit = results.filter(({ res }) => CHECKS.filter((x) => x !== 'confirmed_issue' && x !== 'mapping_accepted').every((x) => res.checks[x] === 'true'));
    const covered = results.some(({ res }) => res.covers);
    if (covered) addressed++;
    return h(
      'div',
      { class: 'card' },
      receipt(e, r),
      h('p', { class: 'sub' }, lit.length ? `Cards that apply: ${lit.map(({ k }) => k.title).join(', ')}` : 'No card in the deck applies to this case.'),
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: () => (dispose([e.id], 'issue'), render()) }, 'Confirm as an issue'),
        h('button', { onclick: () => (dispose([e.id], 'not-a-problem'), render()) }, 'Not a problem'),
        ...lit.map(({ k }) =>
          h(
            'button',
            {
              disabled: S.disp.get(e.id) !== 'issue',
              onclick: () => set({ deck: withCards(S.deck, S.deck.cards.map((g) => (g.id === k.id ? acceptMapping(g, e.id) : g))) }),
            },
            `Accept: ${k.title}`,
          ),
        ),
      ),
      h('p', { class: covered ? 'ok' : 'sub' }, covered ? 'Addressed by the proposed instructions.' : 'Open.'),
    );
  });
  return h(
    'section',
    {},
    h('h1', {}, 'The boss'),
    h('p', { class: 'sub' }, `Later cases you have not seen yet, replayed through the same cover rule. ${addressed} of ${items.length} addressed.`),
    ...views,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => nextNode() }, 'Go to Apply')),
  );
}

function viewAudit(): HTMLElement {
  const cases = reviewedCases();
  const L = renderLanes(S.deck);
  const now = coverage(presentCards(S.deck), cases, deckExportMap(S.deck, L));
  const base = newDeck(S.deck.originals.claude, S.deck.originals.codex, S.deck.originals.codexOverride);
  const before = coverage(presentCards(base), cases, deckExportMap(base, renderLanes(base)));
  const pivots = [...S.rooms.flatMap((r) => [...r.episodes, ...r.withheld])].filter((e) => S.disp.get(e.id) === 'pivot').length;
  const workflows = S.deck.cards.filter((c) => c.family === 'workflow').length;
  return h(
    'section',
    {},
    h('h1', {}, 'Final audit'),
    h('p', {}, `${now.addressed} of ${now.confirmed} reviewed cases addressed by the proposed instructions (the files as they are now: ${before.addressed} of ${before.confirmed}).`),
    h('p', { class: 'sub' }, `Changes of plan set aside: ${pivots}. Workflows preserved as cards: ${workflows}.`),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => nextNode() }, 'Go to Apply')),
  );
}

// ---------------------------------------------------------------- views: diff and receipt
function diffBlock(label: string, before: Uint8Array | null, after: Uint8Array, extra: Child = null): HTMLElement {
  const ops = lineDiff(utf8(before ?? new Uint8Array(0)), utf8(after));
  return h('div', {}, h('h2', {}, label), extra, ops.every((o) => o.op === 'same') ? h('p', { class: 'sub' }, 'No change.') : h('pre', {}, renderDiff(ops)));
}

function viewExported(): HTMLElement {
  const L = renderLanes(S.deck);
  const block = (l: LaneResult) => {
    const t = utf8(l.next);
    const i = t.indexOf('<!-- deck:begin');
    return h('div', {}, h('h2', {}, l.lane.label), h('pre', {}, i >= 0 ? t.slice(i) : 'No change.'));
  };
  return h('section', {}, h('h1', {}, 'Exported — not applied'), h('p', { class: 'sub' }, 'This browser cannot write files. Paste each block at the end of the file named above; nothing was changed on disk.'), block(L.claude), block(L.codex));
}

function viewDiff(): HTMLElement {
  if (!hasFSA && S.mode === 'real') return viewExported();
  const needClaude = !S.dirs.claudeLoaded || (S.mode === 'real' && !S.dirs.claude);
  const needCodex = !S.dirs.codexLoaded || (S.mode === 'real' && !S.dirs.codex);
  const wantsSkill = S.deck.cards.some((c) => c.type === 'skill' && c.taken);
  if (needClaude || needCodex) {
    return h(
      'section',
      {},
      h('h1', {}, 'Your two rule files'),
      h('p', { class: 'sub' }, 'To show the diff, the game needs the files your agents read. From these folders it opens only CLAUDE.md, AGENTS.md, AGENTS.override.md and the skills folders.'),
      h('div', { class: 'row' }, needClaude && h('button', { onclick: () => void grant('claude') }, 'Choose ~/.claude'), needCodex && h('button', { onclick: () => void grant('codex') }, 'Choose ~/.codex')),
    );
  }
  const t = S.targets;
  if (!t) return h('section', {}, h('p', { class: 'sub' }, 'Preparing the diff…'), h('button', { onclick: () => void prepareDiff() }, 'Prepare the diff'));
  const cases = reviewedCases();
  const now = coverage(presentCards(S.deck), cases, deckExportMap(S.deck, t.lanes));
  const skills = t.targets.filter((x) => x.kind === 'skill');
  const lane = (l: LaneResult) => diffBlock(l.lane.label, l.original, l.next, h('div', {}, l.blocker && h('p', { class: 'warn' }, l.blocker), h('p', { class: 'num' }, `Weight ${l.before.total} → ${l.after.total} of ${l.allowance}${l.noGrowth ? ' (no-growth)' : ''}`), l.problem && h('p', { class: 'warn' }, l.problem)));
  const reds = conflicts(S.deck);
  return h(
    'section',
    {},
    h('h1', {}, 'The diff'),
    h('p', {}, `${now.addressed} of ${now.confirmed} reviewed cases addressed by the proposed instructions.`),
    wantsSkill && !S.dirs.agents && S.mode === 'real' && h('div', { class: 'row' }, h('span', { class: 'sub' }, 'Codex reads skills from ~/.agents/skills. Grant it to write the Skill for Codex too; without it the Codex pointer is left out.'), h('button', { onclick: () => void grant('agents') }, 'Choose ~/.agents')),
    ...t.notes.map((n) => h('p', { class: 'sub' }, n)),
    ...t.problems.map((p) => h('p', { class: 'warn' }, p)),
    reds.length > 0 && h('p', { class: 'warn' }, `${reds.length} red link${reds.length === 1 ? '' : 's'} unresolved. Go back to a campfire to resolve.`),
    ...skills.map((s) => diffBlock(`${s.root === 'claude-skills' ? '~/.claude/skills' : '~/.agents/skills'}/${s.rel}`, null, s.next, h('p', { class: 'sub' }, 'Skill bodies are written before the files that point to them.'))),
    lane(t.lanes.claude),
    lane(t.lanes.codex),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', disabled: !S.plan || reds.length > 0 || !!t.lanes.claude.problem || !!t.lanes.codex.problem, onclick: () => void doApply() }, S.mode === 'sample' ? 'Apply to the sample files' : 'Apply'),
      h('button', { onclick: () => void prepareDiff() }, 'Reread and rebuild the diff'),
    ),
    h('p', { class: 'sub' }, 'Apply rereads every file first. If any changed since this diff, nothing is written.'),
  );
}

function viewReceipt(): HTMLElement {
  const r = S.result!;
  const head = (() => {
    switch (r.status) {
      case 'written': {
        const ops = r.receipt.files.map((f) => (f.root === 'claude' ? 'Claude rules updated' : f.root === 'codex' ? 'Codex rules updated' : `Skill ${f.created ? 'created' : 'updated'} (${f.root === 'claude-skills' ? 'Claude' : 'Codex'})`));
        return h('div', {}, h('h1', {}, 'Written'), h('p', { class: 'ok' }, ops.join(' · ')), h('p', { class: 'mono sub' }, `Recovery bundle .deck-backups/${r.receipt.bundleId}`));
      }
      case 'unchanged':
        return h('div', {}, h('h1', {}, 'Review complete, no change needed'), h('p', { class: 'sub' }, 'The files already say exactly this. Nothing was written.'));
      case 'stale':
        return h('div', {}, h('h1', {}, 'Stopped before writing'), h('p', { class: 'warn' }, `Changed since the diff: ${r.changed.map((c) => c.rel).join(', ')}. Review the new diff.`), h('button', { onclick: () => (set({ step: 'act' }), void prepareDiff()) }, 'Rebuild the diff'));
      case 'rejected':
        return h('div', {}, h('h1', {}, 'Not applied'), h('p', { class: 'warn' }, r.reason));
      case 'backup-failed':
        return h('div', {}, h('h1', {}, 'Not applied'), h('p', { class: 'warn' }, `The recovery copy could not be verified: ${r.error}. Nothing was written.`));
      case 'partial':
        return h('div', {}, h('h1', {}, 'Apply incomplete, recovery needed'), h('p', { class: 'warn' }, `${r.failed.rel}: ${r.failed.error}`), h('p', {}, `Changed: ${r.journal.filter((j) => j.observed !== 'before').map((j) => j.rel).join(', ') || 'none'}`));
    }
  })();
  const canUndo = r.status === 'written' || r.status === 'partial';
  const undo = S.undo;
  return h(
    'section',
    {},
    head,
    canUndo && !undo && h('div', { class: 'row' }, h('button', { class: 'accent', onclick: () => void doUndo() }, r.status === 'partial' ? 'Restore the changed files' : 'Undo Apply')),
    undo &&
      (undo.status === 'refused'
        ? h('p', { class: 'warn' }, undo.reason)
        : h(
            'div',
            {},
            h('h2', {}, 'Undo'),
            ...undo.files.map((f) =>
              f.status === 'conflict'
                ? h('div', {}, h('p', { class: 'warn' }, `${f.rel}: changed after Apply. Nothing was overwritten. Restore diff:`), h('pre', {}, renderDiff(lineDiff(utf8(f.current ?? new Uint8Array(0)), utf8(f.original ?? new Uint8Array(0))))), h('button', { onclick: () => void forceRestore(f.rel, f.root, f.currentSha) }, 'Restore the original anyway'))
                : h('p', {}, `${f.root === 'claude-skills' ? '~/.claude/skills/' : f.root === 'codex-skills' ? '~/.agents/skills/' : ''}${f.rel}: ${f.status === 'restored' ? (r.status === 'written' && r.receipt.files.some((x) => x.root === f.root && x.rel === f.rel && x.created) ? 'removed; it did not exist before (its folder stays)' : 'restored to the original bytes') : f.status === 'already-original' ? 'already the original' : `failed: ${f.status === 'failed' ? f.error : ''}`}`),
            ),
          )),
    S.mode === 'sample' && h('div', { class: 'row' }, h('button', { onclick: () => void resetSample().then(() => location.reload()) }, 'Reset the sample')),
    h('footer', {}, 'Saved for future sessions. This game did not test whether an agent follows these instructions.'),
  );
}

function viewAct(): HTMLElement {
  const n = currentNode();
  if (!n) return h('section', {}, h('p', {}, 'No route.'));
  const head = h('p', { class: 'sub' }, `Step ${S.node + 1} of ${S.route.length} · ${nodeLabel(n)}`);
  let body: HTMLElement;
  switch (n.kind) {
    case 'campfire':
      body = viewCampfire();
      break;
    case 'boss':
      body = viewBoss(n);
      break;
    case 'audit':
      body = viewAudit();
      break;
    case 'apply':
      body = viewDiff();
      break;
    case 'card-review':
      body = h('section', {}, h('h1', {}, 'Your existing rules'), h('p', { class: 'sub' }, 'Each line read from your files has a suggested mapping; it counts toward coverage only after you accept it at a campfire.'), h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => nextNode() }, 'Continue')));
      break;
    default: {
      const r = roomByKey(n.rooms[Math.min(S.sub, n.rooms.length - 1)]!);
      body = r ? viewRoom(r) : h('p', {}, 'Room not found.');
    }
  }
  return h('div', {}, head, body);
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
  const view = S.step === 'import' ? viewImport() : S.step === 'reading' ? viewReading() : S.step === 'mirror' ? viewMirror() : S.step === 'act' ? viewAct() : viewReceipt();
  app.replaceChildren(steps(), S.error ? h('p', { class: 'warn' }, S.error) : '', S.busy ? h('p', { class: 'sub' }, S.busy) : '', view);
}

// Exposed for the browser smoke test only.
(window as unknown as { __deck: unknown }).__deck = { state: S, weigh };

loadRemembered();
render();
// "#play" (debug render) and "#play-ui" (the workers' screens) open the play loop on the synthetic sample. The slice
// stays the default route until P1 replaces it.
if (location.hash === '#play' || location.hash === '#play-ui') void startSample();
