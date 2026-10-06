// The slice UI: Import → counts → one Room → Diff → Apply → receipt → Undo.
// Plain and functional on purpose; the final material is co-designed elsewhere.
// Every string from a log is set with textContent, never parsed as HTML.

import './style.css';
import type { Session, Turn } from '../model';
import { detectEpisodes, mirror, type Episode, type MirrorCounts } from '../episodes';
import { caseFor, constraintKeyOf, draftCards, groupRooms, type Room } from '../deck/templates';
import { acceptMapping, setTaken, updateCard } from '../deck/card';
import type { Card, Case } from '../deck/types';
import { buildLane, CLAUDE_LANE, codexLane, exportMap, type LaneResult } from '../deck/lanes';
import { sanitizeLine, text as utf8 } from '../deck/file';
import { lineDiff, renderDiff } from '../deck/diff';
import { coverage } from '../cover';
import { applyPlan, makePlan, restoreOriginalSeen, undoBundle } from '../apply/engine';
import { ensureWritable, fsaRoot } from '../apply/fsa-root';
import type { ApplyResult, Plan, Root, UndoResult } from '../apply/types';
import { claudeCandidates, codexCandidates, droppedCandidates, selectRun, type Candidate, type Selection } from './importer';
import { resetSample, sampleDirs, sampleFiles } from './sample';
import type { ParseReply } from './worker';

type Step = 'import' | 'mirror' | 'room' | 'diff' | 'receipt';

interface State {
  step: Step;
  mode: 'sample' | 'real' | null;
  busy: string | null;
  error: string | null;
  candidates: Candidate[];
  selection: Selection | null;
  sessions: Session[];
  failed: number;
  mirror: MirrorCounts | null;
  episodes: Episode[];
  rooms: Room[];
  roomIndex: number;
  cases: Map<string, Case>;
  drafts: Card[];
  taken: Card[];
  boundary: string;
  editing: string | null;
  inspect: boolean;
  dirs: { claude: FileSystemDirectoryHandle | null; codex: FileSystemDirectoryHandle | null };
  globals: { claude: Uint8Array | null; codex: Uint8Array | null; codexOverride: Uint8Array | null; loaded: { claude: boolean; codex: boolean } };
  roots: Root[] | null;
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
  sessions: [],
  failed: 0,
  mirror: null,
  episodes: [],
  rooms: [],
  roomIndex: 0,
  cases: new Map(),
  drafts: [],
  taken: [],
  boundary: '',
  editing: null,
  inspect: false,
  dirs: { claude: null, codex: null },
  globals: { claude: null, codex: null, codexOverride: null, loaded: { claude: false, codex: false } },
  roots: null,
  plan: null,
  result: null,
  undo: null,
};

// ---------------------------------------------------------------- tiny DOM helper (text only)
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'disabled') (el as HTMLButtonElement).disabled = Boolean(v);
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const app = document.getElementById('app')!;
const hasFSA = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

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
    const dir = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'claude-home', mode: 'read' });
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
    const dir = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'codex-sessions', mode: 'read' });
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

function parse(files: { rel: string; blob: Blob; agent?: Session['agent'] }[]): Promise<{ sessions: Session[]; failed: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<ParseReply>) => {
      if (ev.data.type === 'progress') {
        S.busy = `Reading sessions ${ev.data.done} of ${ev.data.total}…`;
        render();
      } else {
        w.terminate();
        resolve({ sessions: ev.data.sessions, failed: ev.data.failed });
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message));
    };
    w.postMessage({ files });
  });
}

async function startRun(files: { rel: string; blob: Blob; agent?: Session['agent'] }[]): Promise<void> {
  try {
    set({ busy: 'Reading sessions…', error: null });
    const { sessions, failed } = await parse(files);
    const episodes = sessions.flatMap(detectEpisodes);
    const rooms = groupRooms(episodes);
    const cases = new Map<string, Case>();
    for (const e of episodes) cases.set(e.id, caseFor(e));
    S.sessions = sessions;
    S.failed = failed;
    S.mirror = mirror(sessions);
    S.episodes = episodes;
    S.rooms = rooms;
    S.cases = cases;
    S.roomIndex = 0;
    S.taken = [];
    S.boundary = '';
    if (S.mode === 'real' && S.dirs.claude) {
      S.globals.claude = await readIn(S.dirs.claude, 'CLAUDE.md');
      S.globals.loaded.claude = true;
    }
    refreshDrafts();
    set({ busy: null, step: 'mirror' });
  } catch (e) {
    fail(e);
  }
}

async function startSample(): Promise<void> {
  S.mode = 'sample';
  S.candidates = [];
  const dirs = await sampleDirs();
  S.dirs = dirs;
  S.globals.claude = await readIn(dirs.claude, 'CLAUDE.md');
  S.globals.codex = await readIn(dirs.codex, 'AGENTS.md');
  S.globals.codexOverride = null;
  S.globals.loaded = { claude: true, codex: true };
  await startRun(sampleFiles());
  S.globals.claude = await readIn(dirs.claude, 'CLAUDE.md');
  render();
}

async function readIn(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- room
function room(): Room | null {
  return S.rooms[S.roomIndex] ?? null;
}

function anchorEpisode(r: Room): Episode {
  const score = (e: Episode) => (e.type === 'interrupt' ? (e.receipt.quote ? (e.pasted ? 1 : 3) : 0) : 2);
  return [...r.episodes].sort((a, b) => score(b) - score(a))[0]!;
}

function refreshDrafts(): void {
  const r = room();
  S.drafts = r ? draftCards(r, { boundary: r.family === 'boundary' ? S.boundary.trim() || null : null }) : [];
  S.editing = null;
}

function setDisposition(r: Room, d: Case['disposition']): void {
  const e = anchorEpisode(r);
  const c = S.cases.get(e.id);
  if (c) S.cases.set(e.id, { ...c, disposition: d });
}

function take(card: Card): void {
  const r = room();
  if (!r) return;
  const e = anchorEpisode(r);
  const c = S.cases.get(e.id)!;
  // Taking a card is the player's statement: this case is an issue, and this card answers it.
  const facts = r.family === 'boundary' && card.trigger.constraintKey ? { ...c.facts, constraintKey: card.trigger.constraintKey } : c.facts;
  S.cases.set(e.id, { ...c, disposition: 'issue', facts });
  const accepted = setTaken(acceptMapping(card, e.id), true);
  S.taken = [...S.taken.filter((t) => t.id !== card.id), accepted];
  nextRoom();
}

function nextRoom(): void {
  S.roomIndex = Math.min(S.roomIndex + 1, S.rooms.length);
  S.boundary = '';
  S.inspect = false;
  refreshDrafts();
  set({ step: S.roomIndex >= S.rooms.length ? 'diff' : 'room' });
  if (S.step === 'diff') void prepareDiff();
}

// ---------------------------------------------------------------- lanes, diff, apply
function lanes(): { claude: LaneResult; codex: LaneResult } {
  const cl = buildLane(CLAUDE_LANE, S.globals.claude, S.taken);
  const cx = buildLane(codexLane(S.globals.codexOverride), S.mode === 'sample' ? S.globals.codex : S.globals.codex, S.taken);
  return { claude: cl, codex: cx };
}

async function grantCodexHome(): Promise<void> {
  try {
    const dir = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'codex-home', mode: 'readwrite' });
    S.dirs.codex = dir;
    // Only the instruction files are read from this folder.
    S.globals.codexOverride = await readIn(dir, 'AGENTS.override.md');
    S.globals.codex = await readIn(dir, codexLane(S.globals.codexOverride).rel);
    S.globals.loaded.codex = true;
    await prepareDiff();
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') fail(e);
  }
}

async function grantClaudeHome(): Promise<void> {
  try {
    const dir = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'claude-home', mode: 'readwrite' });
    S.dirs.claude = dir;
    S.globals.claude = await readIn(dir, 'CLAUDE.md');
    S.globals.loaded.claude = true;
    await prepareDiff();
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') fail(e);
  }
}

function buildRoots(): Root[] | null {
  if (!S.dirs.claude || !S.dirs.codex) return null;
  if (S.roots) return S.roots;
  const label = S.mode === 'sample' ? 'sample' : '~';
  S.roots = [fsaRoot('claude', S.dirs.claude, `${label}/.claude`), fsaRoot('codex', S.dirs.codex, `${label}/.codex`), fsaRoot('backup', S.dirs.claude, `${label}/.claude`)];
  return S.roots;
}

async function prepareDiff(): Promise<void> {
  try {
    const roots = buildRoots();
    if (!roots || !S.globals.loaded.claude || !S.globals.loaded.codex) {
      set({ step: 'diff', plan: null });
      return;
    }
    const L = lanes();
    if (L.claude.problem || L.codex.problem) {
      set({ step: 'diff', plan: null });
      return;
    }
    const plan = await makePlan(roots, [
      { root: 'claude', rel: L.claude.lane.rel, kind: 'global', next: L.claude.next },
      { root: 'codex', rel: L.codex.lane.rel, kind: 'global', next: L.codex.next },
    ]);
    set({ step: 'diff', plan, result: null, undo: null });
  } catch (e) {
    fail(e);
  }
}

async function doApply(): Promise<void> {
  if (!S.plan || !S.roots) return;
  try {
    if (S.mode === 'real') {
      const ok = (await ensureWritable(S.dirs.claude!)) && (await ensureWritable(S.dirs.codex!));
      if (!ok) throw new Error('Write access was not granted.');
    }
    set({ busy: 'Writing and reading back…', error: null });
    const result = await applyPlan(S.plan, S.roots, S.plan.digest);
    set({ busy: null, result, step: 'receipt' });
  } catch (e) {
    fail(e);
  }
}

async function doUndo(): Promise<void> {
  const r = S.result;
  if (!r || !S.roots) return;
  const bundleId = r.status === 'written' ? r.receipt.bundleId : r.status === 'partial' ? r.bundleId : null;
  if (!bundleId) return;
  set({ busy: 'Restoring…' });
  const undo = await undoBundle(bundleId, S.roots);
  set({ busy: null, undo });
}

async function forceRestore(rel: string, root: 'claude' | 'codex', seenSha: string | null): Promise<void> {
  const r = S.result;
  if (!r || !S.roots) return;
  const bundleId = r.status === 'written' ? r.receipt.bundleId : r.status === 'partial' ? r.bundleId : null;
  if (!bundleId) return;
  const res = await restoreOriginalSeen(bundleId, S.roots, { root, rel }, seenSha);
  if (S.undo?.status === 'done') S.undo = { status: 'done', files: S.undo.files.map((f) => (f.rel === rel && f.root === root ? res : f)) };
  render();
}

// ---------------------------------------------------------------- views
function steps(): HTMLElement {
  const names: [Step, string][] = [
    ['import', 'Import'],
    ['mirror', 'Counts'],
    ['room', 'Room'],
    ['diff', 'Diff'],
    ['receipt', 'Receipt'],
  ];
  return h('nav', { class: 'steps' }, ...names.map(([k, n]) => h('span', { class: S.step === k ? 'on' : '' }, n)));
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
  return h(
    'section',
    {},
    h('h1', {}, 'Your rules file is a deck.'),
    h('p', { class: 'sub' }, 'Read your recent Claude Code and Codex sessions, review what happened, and write better rules into CLAUDE.md and AGENTS.md. Everything stays in this tab.'),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', onclick: () => void startSample() }, 'Play the sample'),
      hasFSA && h('button', { onclick: () => void pickClaude() }, 'Choose your ~/.claude folder'),
      hasFSA && h('button', { onclick: () => void pickCodexSessions() }, 'Choose ~/.codex/sessions'),
    ),
    !hasFSA && h('p', { class: 'sub' }, 'This browser cannot open folders. Drop session files instead; Apply will offer an exported bundle.'),
    drop,
    h('p', { class: 'sub' }, 'Only projects/**/*.jsonl under ~/.claude and rollout-*.jsonl under ~/.codex/sessions are read. Secrets are redacted as each line is parsed.'),
    sel &&
      h(
        'div',
        {},
        h('h2', {}, 'This run'),
        h(
          'table',
          {},
          h('tr', {}, h('td', {}, 'Window'), h('td', { class: 'num' }, `last ${sel.window.days} days, up to ${sel.window.perAgent} per agent`)),
          h('tr', {}, h('td', {}, 'Claude Code sessions'), h('td', { class: 'num' }, String(claudeN))),
          h('tr', {}, h('td', {}, 'Codex sessions'), h('td', { class: 'num' }, String(codexN))),
          h('tr', {}, h('td', {}, 'Left out'), h('td', { class: 'num' }, `${sel.excluded.tooOld} older · ${sel.excluded.subagent} subagent threads · ${sel.excluded.overPerAgent} beyond the per-agent limit · ${sel.excluded.overBudget} over the size budget`)),
        ),
        h('button', { class: 'primary', disabled: sel.chosen.length === 0, onclick: () => void startRun(sel.chosen.map((c) => ({ rel: c.rel, blob: c.file, agent: c.agent }))) }, 'Start the run'),
      ),
  );
}

function viewMirror(): HTMLElement {
  const m = S.mirror!;
  const rows: [string, string][] = [
    ['Sessions', `${m.sessions.total} (Claude Code ${m.sessions.claude}, Codex ${m.sessions.codex})`],
    ['Partial sessions', `${m.sessions.partial} of ${m.sessions.total}`],
    ['Agent-authored threads', `${m.sessions.agentAuthored} of ${m.sessions.total}`],
    ['Your messages', `${m.humanTurns} (quarantined injected text: ${m.injectedTurns})`],
    ['Stops followed by your next message', `${m.interruptPairs} of ${m.interrupts} stops`],
    ['Same command failing again with nothing changed', `${m.repeatedCommand.episodes} in ${m.repeatedCommand.sessionsWith} of ${m.sessions.total} sessions`],
    ['Tool calls with a recorded result', `${m.calls.withResult} of ${m.calls.total}`],
    ['Secrets redacted while reading', String(m.redactions)],
    ['Rooms to review', String(S.rooms.length)],
  ];
  return h(
    'section',
    {},
    h('h1', {}, S.mode === 'sample' ? 'What the sample shows' : 'What your sessions show'),
    h('p', { class: 'sub' }, 'Counts only. Nothing below is a problem until you say so.'),
    h('table', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, v)))),
    S.failed > 0 && h('p', { class: 'warn' }, `${S.failed} files could not be read.`),
    h('div', { class: 'row' }, h('button', { class: 'primary', disabled: S.rooms.length === 0, onclick: () => set({ step: 'room' }) }, 'Enter the first room'), S.rooms.length === 0 && h('span', { class: 'sub' }, 'No anchored evidence in this run.')),
  );
}

function sessionOf(id: string): Session | undefined {
  return S.sessions.find((s) => s.id === id);
}

function viewInspect(e: Episode): HTMLElement {
  const s = sessionOf(e.sessionId);
  if (!s) return h('p', {}, 'Source not loaded.');
  const from = Math.max(0, e.turn - 3);
  const to = Math.min(s.turns.length, e.turn + 4);
  const line = (t: Turn) =>
    h(
      'div',
      { class: 'turn' },
      h('b', {}, `${t.i} ${t.role}${t.injected ? `:${t.injected}` : ''}${t.interrupt ? `:${t.interrupt}` : ''} `),
      t.text.slice(0, 300),
      ...t.calls.slice(-4).map((c) => h('div', { class: 'mono sub' }, `→ ${c.name} ${c.command ?? c.files.join(', ')} · ${c.result ? `${c.result.status}${c.result.exitCode !== null ? ` exit ${c.result.exitCode}` : ''}` : 'no result'}`)),
    );
  return h('div', {}, h('p', { class: 'sub' }, `${s.agent === 'claude' ? 'Claude Code' : 'Codex'} · ${s.file} · ${s.startedAt?.slice(0, 16) ?? ''}`), ...s.turns.slice(from, to).map(line));
}

function cardView(card: Card, r: Room): HTMLElement {
  const isTaken = S.taken.some((t) => t.id === card.id);
  const needsBoundary = r.family === 'boundary' && card.responseKey === 'preserve_boundary' && !card.trigger.constraintKey;
  const editing = S.editing === card.id;
  const ta = h('textarea', { rows: 3 }, card.text) as HTMLTextAreaElement;
  const sel = h(
    'select',
    {},
    ...(['both', 'claude', 'codex'] as const).map((t) => {
      const o = h('option', { value: t }, t === 'both' ? 'Claude + Codex' : t === 'claude' ? 'Claude only' : 'Codex only');
      if (card.targets === t) o.selected = true;
      return o;
    }),
  ) as HTMLSelectElement;
  return h(
    'div',
    { class: `card${isTaken ? ' taken' : ''}` },
    h('h3', {}, card.title),
    editing ? ta : h('p', {}, card.text),
    editing && sel,
    h('div', { class: 'chips' }, h('span', { class: 'chip' }, card.targets === 'both' ? 'Claude + Codex' : card.targets === 'claude' ? 'Claude' : 'Codex'), h('span', { class: 'chip' }, card.scope.kind === 'global' ? 'all projects' : card.scope.label), h('span', { class: 'chip mono' }, `~${Math.ceil((card.text.length + 20) / 3)} tok`)),
    needsBoundary && h('p', { class: 'sub' }, 'Write the boundary above to use this one.'),
    h(
      'div',
      { class: 'row' },
      editing
        ? h(
            'button',
            {
              onclick: () => {
                const next = updateCard(card, { text: ta.value, targets: sel.value as Card['targets'] }, sanitizeLine);
                S.drafts = S.drafts.map((d) => (d.id === card.id ? next : d));
                set({ editing: null });
              },
            },
            'Done',
          )
        : h('button', { class: 'primary', disabled: needsBoundary, onclick: () => take(card) }, 'Take'),
      !editing && h('button', { onclick: () => set({ editing: card.id }) }, 'Edit'),
    ),
  );
}

function meters(): HTMLElement {
  const L = lanes();
  const meter = (name: string, l: LaneResult, loaded: boolean) => {
    if (!loaded) return h('div', { class: 'meter' }, h('b', {}, name), h('div', { class: 'sub' }, 'Not loaded yet. It is read at the Diff step.'));
    const pct = Math.min(100, Math.round((l.after.total / l.allowance) * 100));
    return h(
      'div',
      { class: 'meter' },
      h('b', {}, name),
      h('span', { class: 'num' }, `  ${l.after.total} / ${l.allowance}`),
      l.noGrowth && h('span', { class: 'sub' }, ' · no-growth: already over the allowance'),
      h('div', { class: `bar${l.after.total > l.allowance ? ' over' : ''}` }, h('i', { style: `width:${pct}%` })),
    );
  };
  return h('div', { class: 'deck' }, meter('CLAUDE.md', L.claude, S.globals.loaded.claude), meter(L.codex.lane.rel, L.codex, S.globals.loaded.codex));
}

function viewRoom(): HTMLElement {
  const r = room();
  if (!r) return h('section', {}, h('p', {}, 'No rooms left.'), h('button', { onclick: () => void prepareDiff() }, 'Go to the diff'));
  const e = anchorEpisode(r);
  const input = h('input', { type: 'text', value: S.boundary, placeholder: 'The boundary, in your words (e.g. "Never edit files under vendor/")' }) as HTMLInputElement;
  input.addEventListener('change', () => {
    S.boundary = input.value;
    refreshDrafts();
    render();
  });
  return h(
    'section',
    {},
    h('p', { class: 'sub' }, `Room ${S.roomIndex + 1} of ${S.rooms.length}`),
    h('h1', {}, r.name),
    h('p', { class: 'sub' }, r.subtitle),
    h(
      'div',
      { class: 'receipt' },
      h('p', { class: 'quote' }, e.receipt.quote ? `“${e.receipt.quote}”` : 'Tool evidence only'),
      e.type === 'interrupt' && e.pasted && h('p', { class: 'sub' }, 'This looks like pasted text, shortened.'),
      h('p', { class: 'mono sub' }, `Action: ${e.receipt.action ?? 'none recorded'}`),
      h('p', { class: 'mono sub' }, `Result: ${e.receipt.result ?? 'none recorded'}`),
      h('p', { class: 'sub' }, `${e.agent === 'claude' ? 'Claude Code' : 'Codex'}${e.projectLabel ? ` · ${e.projectLabel}` : ''} · supporting sessions: ${r.sessions}`),
    ),
    r.family === 'boundary' && h('div', { class: 'row' }, input),
    h('div', { class: 'cards' }, ...S.drafts.map((c) => cardView(c, r))),
    h(
      'div',
      { class: 'row' },
      h('button', { onclick: () => nextRoom() }, 'Skip'),
      h('button', { onclick: () => (setDisposition(r, 'not-a-problem'), nextRoom()) }, 'Not a problem'),
      r.family === 'boundary' && h('button', { onclick: () => (setDisposition(r, 'pivot'), nextRoom()) }, 'I changed my mind (pivot)'),
      h('button', { onclick: () => set({ inspect: !S.inspect }) }, S.inspect ? 'Hide source' : 'Inspect source'),
      h('button', { class: 'accent', onclick: () => void prepareDiff() }, 'Go to the diff'),
    ),
    S.inspect && viewInspect(e),
    meters(),
  );
}

function diffBlock(l: LaneResult): HTMLElement {
  const ops = lineDiff(utf8(l.original ?? new Uint8Array(0)), utf8(l.next));
  return h(
    'div',
    {},
    h('h2', {}, l.lane.label),
    l.lane.notice && h('p', { class: 'sub' }, l.lane.notice),
    h('p', { class: 'num' }, `Weight ${l.before.total} → ${l.after.total} of ${l.allowance}${l.noGrowth ? ' (no-growth)' : ''}`),
    l.problem && h('p', { class: 'warn' }, l.problem),
    ops.every((o) => o.op === 'same') ? h('p', { class: 'sub' }, 'No change.') : h('pre', {}, renderDiff(ops)),
  );
}

function viewExported(): HTMLElement {
  const L = lanes();
  const block = (l: LaneResult) => {
    const t = utf8(l.next);
    const i = t.indexOf('<!-- deck:begin');
    return h('div', {}, h('h2', {}, l.lane.label), h('pre', {}, i >= 0 ? t.slice(i) : 'No change.'));
  };
  return h(
    'section',
    {},
    h('h1', {}, 'Exported — not applied'),
    h('p', { class: 'sub' }, 'This browser cannot write files. Paste each block at the end of the file named above; nothing was changed on disk.'),
    block(L.claude),
    block(L.codex),
  );
}

function viewDiff(): HTMLElement {
  if (!hasFSA && S.mode === 'real') return viewExported();
  const needClaude = !S.globals.loaded.claude || (S.mode === 'real' && !S.dirs.claude);
  const needCodex = !S.globals.loaded.codex || (S.mode === 'real' && !S.dirs.codex);
  if (needClaude || needCodex) {
    return h(
      'section',
      {},
      h('h1', {}, 'Your two rule files'),
      h('p', { class: 'sub' }, 'To show the diff, the game needs the files your agents read. From these folders it opens only CLAUDE.md, AGENTS.md and AGENTS.override.md.'),
      h('div', { class: 'row' }, needClaude && h('button', { onclick: () => void grantClaudeHome() }, 'Choose ~/.claude'), needCodex && h('button', { onclick: () => void grantCodexHome() }, 'Choose ~/.codex')),
    );
  }
  const L = lanes();
  const reviewed = [...S.cases.values()];
  const ex = exportMap(L.claude.next, L.codex.next);
  const cov = coverage(S.taken, reviewed, ex);
  const base = coverage([], reviewed, exportMap(L.claude.original ?? new Uint8Array(0), L.codex.original ?? new Uint8Array(0)));
  const blocked = !!(L.claude.problem || L.codex.problem) || !S.plan;
  return h(
    'section',
    {},
    h('h1', {}, 'The diff'),
    h('p', {}, `${cov.addressed} of ${cov.confirmed} reviewed cases addressed by the proposed instructions (before: ${base.addressed} of ${base.confirmed}).`),
    diffBlock(L.claude),
    diffBlock(L.codex),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', disabled: blocked || S.taken.length === 0, onclick: () => void doApply() }, S.mode === 'sample' ? 'Apply to the sample files' : 'Apply'),
      h('button', { onclick: () => set({ step: S.rooms.length ? 'room' : 'mirror', roomIndex: Math.min(S.roomIndex, Math.max(0, S.rooms.length - 1)) }) }, 'Back to the rooms'),
    ),
    S.taken.length === 0 && h('p', { class: 'sub' }, 'Take at least one card to write anything.'),
    h('p', { class: 'sub' }, 'Apply rereads both files first. If either changed since this diff, nothing is written.'),
  );
}

function viewReceipt(): HTMLElement {
  const r = S.result!;
  const head = (() => {
    switch (r.status) {
      case 'written':
        return h('div', {}, h('h1', {}, 'Written'), h('p', { class: 'ok' }, r.receipt.files.map((f) => (f.root === 'claude' ? 'Claude rules updated' : 'Codex rules updated')).join(' · ')), h('p', { class: 'mono sub' }, `Recovery bundle .deck-backups/${r.receipt.bundleId}`));
      case 'unchanged':
        return h('div', {}, h('h1', {}, 'No change needed'), h('p', { class: 'sub' }, 'Both files already say exactly this. Nothing was written.'));
      case 'stale':
        return h('div', {}, h('h1', {}, 'Stopped before writing'), h('p', { class: 'warn' }, `Changed since the diff: ${r.changed.map((c) => c.rel).join(', ')}. Review the new diff.`), h('button', { onclick: () => void prepareDiff() }, 'Rebuild the diff'));
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
                ? h(
                    'div',
                    {},
                    h('p', { class: 'warn' }, `${f.rel}: changed after Apply. Nothing was overwritten. Restore diff:`),
                    h('pre', {}, renderDiff(lineDiff(utf8(f.current ?? new Uint8Array(0)), utf8(f.original ?? new Uint8Array(0))))),
                    h('button', { onclick: () => void forceRestore(f.rel, f.root as 'claude' | 'codex', f.currentSha) }, 'Restore the original anyway'),
                  )
                : h('p', {}, `${f.rel}: ${f.status === 'restored' ? 'restored to the original bytes' : f.status === 'already-original' ? 'already the original' : `failed: ${f.status === 'failed' ? f.error : ''}`}`),
            ),
          )),
    S.mode === 'sample' && h('div', { class: 'row' }, h('button', { onclick: () => void resetSample().then(() => location.reload()) }, 'Reset the sample')),
    h('footer', {}, 'Saved for future sessions. This game did not test whether an agent follows these instructions.'),
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
  const view = S.step === 'import' ? viewImport() : S.step === 'mirror' ? viewMirror() : S.step === 'room' ? viewRoom() : S.step === 'diff' ? viewDiff() : viewReceipt();
  app.replaceChildren(steps(), S.error ? h('p', { class: 'warn' }, S.error) : '', S.busy ? h('p', { class: 'sub' }, S.busy) : '', view);
}

// Exposed for the browser smoke test only.
(window as unknown as { __deck: unknown }).__deck = { state: S, constraintKeyOf };

render();
