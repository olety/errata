// Owner: boss/apply. Pure presentation helpers for the boss and Apply screens (play-loop §9, §0a.11, §0a.12, §0a.14).
// No DOM, no engine, no adapter: every number on screen comes from a view field; these helpers only decide what to
// show, in which order, and which controls are live. Tested in tests/playloop-end.test.ts.

import type { ApplyBlockerView, ApplyView, BookView, BossHeadView, BossView, CardView, CommitEffectView, Disposition, InkState, ReceiptView, RunSummaryView } from '../contract';
import { AGENT_NAME, COPY, STAMPS } from '../contract';

// ------------------------------------------------------------------ text

/** Inline code arrives as backtick spans: split them so the renderer builds <code> elements with textContent. */
export function splitTicks(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const parts = text.split('`');
  // An unmatched trailing backtick is literal text, never an open code span.
  const closed = parts.length % 2 === 1;
  parts.forEach((p, i) => {
    const code = i % 2 === 1 && (closed || i < parts.length - 1);
    const t = code || !(i % 2 === 1) ? p : '`' + p;
    if (t) out.push({ code, text: t });
  });
  return out;
}

/** Figures print with grouping (1,200), never recomputed. */
export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** "Claude · pyramid · 2026-10-05": the head tag, from the receipt's own fields. */
export function tagText(r: Pick<ReceiptView, 'agent' | 'project' | 'date'>): string {
  return [AGENT_NAME[r.agent], r.project, r.date].filter((x): x is string => !!x).join(' · ');
}

/** The stamp's label for a disposition; null while unreviewed. */
export function stampLabel(d: Disposition): string | null {
  return STAMPS.find((s) => s.stamp === d)?.label ?? null;
}

// ------------------------------------------------------------------ the boss

/** How a revealed head looks, from its disposition and `addressed` only (§4 states). */
export type HeadLook = 'rising' | 'bared' | 'bound' | 'standing' | 'heron' | 'sunk' | 'wrapped';

export function headLook(h: Pick<BossHeadView, 'disposition' | 'addressed'>, current: boolean): HeadLook {
  switch (h.disposition) {
    case 'unreviewed':
      return current ? 'rising' : 'wrapped';
    case 'issue':
      return h.addressed ? 'bound' : current ? 'bared' : 'standing';
    case 'pivot':
      return 'heron';
    case 'not-a-problem':
      return 'sunk';
    case 'unclear':
      return 'wrapped';
  }
}

export type BossAct = 'next' | 'advance' | 'relock';
export interface BossControl {
  act: BossAct;
  label: string;
  primary: boolean;
}

export interface ScoreNote {
  /** The score's validity in words; a stale or live score is never presented as final. */
  note: string;
  final: boolean;
}

export function scoreNote(validity: BossView['score']['validity']): ScoreNote {
  switch (validity) {
    case 'live':
      return { note: 'Live tally · not final', final: false };
    case 'locked':
      return { note: 'Tally fixed to the final deck', final: true };
    case 'stale':
      return { note: 'Stale · the deck changed after the lock. Not final until it locks again.', final: false };
  }
}

export interface BossPlan {
  title: string;
  turn: BossView['turn'];
  current: BossHeadView | null;
  look: HeadLook | null;
  /** Revealed heads other than the current one, in reveal order (oldest sealed first, then Open pages). */
  faced: { head: BossHeadView; look: HeadLook }[];
  /** Sealed heads still under the water: the view's count, never their words. */
  below: number;
  /** The four stamps, only while the current sealed head waits for its blind stamp. */
  stamps: typeof STAMPS | null;
  /** The stamp the current head carries, once stamped. */
  chosen: string | null;
  coach: string | null;
  /** The current head accepts the answer drag (stamped a problem, or an Open page, and not yet addressed). */
  headTarget: boolean;
  /** Deck cards are drag sources only while the head can be answered. */
  dragCards: boolean;
  /** Cards whose candidate glows for the current head. */
  glow: ReadonlySet<string>;
  /** "No eligible card": one row per candidate with its reason. */
  reasons: { cardId: string; title: string; summary: string; reason: string }[];
  controls: BossControl[];
  score: { lines: string[]; validity: BossView['score']['validity'] } & ScoreNote;
  /** At the summary: the set-aside heads, in reveal order (oldest first), each with its stamp. */
  setAside: { head: BossHeadView; label: string }[];
}

export function bossPlan(v: BossView): BossPlan {
  const current = v.current ? (v.heads.find((h) => h.caseId === v.current) ?? null) : null;
  const look = current ? headLook(current, true) : null;
  const faced = v.heads.filter((h) => h !== current).map((head) => ({ head, look: headLook(head, false) }));
  const open = current?.source === 'open';
  const answerable = v.turn === 'answer' && !!current && !current.addressed;
  const glow = new Set(answerable ? v.candidates.filter((c) => c.glow).map((c) => c.cardId) : []);
  const byId = new Map(v.cards.map((c) => [c.id, c]));
  const reasons =
    v.turn === 'answer' && v.noEligibleCard
      ? v.candidates.map((c) => ({ cardId: c.cardId, title: byId.get(c.cardId)?.face.title ?? c.cardId, summary: byId.get(c.cardId)?.face.summary ?? '', reason: c.reason ?? '' }))
      : [];

  let coach: string | null = null;
  let controls: BossControl[] = [];
  switch (v.turn) {
    case 'stamp':
      coach = 'Read the receipt, then stamp it. Blind: nothing in your deck shows anything until you do.';
      controls = [{ act: 'next', label: 'Continue · leave it unstamped', primary: false }];
      break;
    case 'answer':
      if (current?.addressed) {
        coach = 'Answered: a line in your final deck answers this case. It stays a proposed line until Apply.';
        controls = [{ act: 'next', label: 'Continue', primary: true }];
      } else if (v.noEligibleCard) {
        coach = `${COPY.noEligibleCard} · this case stays open.`;
        controls = [{ act: 'next', label: 'Continue', primary: true }];
      } else {
        coach = open ? 'An earlier Open page faces your final deck. Drag a glowing card onto it, or click the card and then the page, to answer it.' : 'Drag a glowing card onto the head, or click the card and then the head, to answer it.';
        controls = [{ act: 'next', label: 'Continue · leave it open', primary: false }];
      }
      break;
    case 'set-aside': {
      const label = current ? stampLabel(current.disposition) : null;
      coach = `Set aside${label ? ` as “${label}”` : ''}. It counts nowhere and is listed at the end.`;
      controls = [{ act: 'next', label: 'Continue', primary: true }];
      break;
    }
    case 'summary':
      controls =
        v.score.validity === 'stale'
          ? [
              { act: 'relock', label: 'Lock the score again', primary: true },
              { act: 'advance', label: 'Go to Apply', primary: false },
            ]
          : [{ act: 'advance', label: 'Go to Apply', primary: true }];
      break;
  }

  const setAside =
    v.turn === 'summary'
      ? v.heads.flatMap((head) => {
          const d = head.disposition;
          return d === 'pivot' || d === 'not-a-problem' || d === 'unclear' ? [{ head, label: stampLabel(d)! }] : [];
        })
      : [];

  return {
    title: v.kind === 'audit' ? 'Final Audit' : 'The sealed heads',
    turn: v.turn,
    current,
    look,
    faced,
    below: v.remaining,
    stamps: v.turn === 'stamp' && current?.source === 'sealed' ? STAMPS : null,
    chosen: current ? stampLabel(current.disposition) : null,
    coach,
    headTarget: answerable,
    dragCards: answerable,
    glow,
    reasons,
    controls,
    score: { lines: v.score.lines, validity: v.score.validity, ...scoreNote(v.score.validity) },
    setAside,
  };
}

/** Each book with its cards, in the book's order; while answering, glowing cards come first so they show unscrolled. */
export function bookRows(books: readonly BookView[], cards: readonly CardView[], glow: ReadonlySet<string>): { book: BookView; cards: CardView[] }[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return books.map((book) => {
    const list = book.cardIds.map((id) => byId.get(id)).filter((c): c is CardView => !!c);
    if (glow.size === 0) return { book, cards: list };
    return { book, cards: [...list.filter((c) => glow.has(c.id)), ...list.filter((c) => !glow.has(c.id))] };
  });
}

/**
 * Presentation memory across repaints: the mount rebuilds the tree on every change, so each animation keys on what
 * the view says happened and plays once (a head rising, a stamp inking, a bind once per effect id, a page tearing,
 * the score inking). Memory advances under reduced motion too, so nothing replays when motion comes back.
 */
export interface BossMemory {
  current: string | null;
  stamped: Set<string>;
  effect: number;
  torn: Set<string>;
  score: string;
}

export function newBossMemory(): BossMemory {
  return { current: null, stamped: new Set(), effect: -1, torn: new Set(), score: '' };
}

export interface BossMotion {
  rise: boolean;
  ink: boolean;
  bind: boolean;
  inkScore: boolean;
  /** Faced heads left standing whose page tears now. */
  tear: ReadonlySet<string>;
}

export function bossMotion(m: BossMemory, plan: BossPlan, effect: CommitEffectView | null, reduced: boolean): BossMotion {
  const cur = plan.current;
  const rise = !!cur && m.current !== cur.caseId;
  m.current = cur?.caseId ?? null;
  const ink = !!cur && !!plan.chosen && !m.stamped.has(cur.caseId);
  if (cur && plan.chosen) m.stamped.add(cur.caseId);
  const freshEffect = !!effect && effect.id !== m.effect;
  if (effect) m.effect = effect.id;
  const bind = freshEffect && effect!.kind === 'boss-answer' && !!cur && effect!.bound.includes(cur.caseId);
  const key = plan.turn === 'summary' ? `${plan.score.validity}|${plan.score.lines.join('|')}` : '';
  const inkScore = plan.turn === 'summary' && m.score !== key;
  if (plan.turn === 'summary') m.score = key;
  const tear = new Set<string>();
  for (const f of plan.faced) {
    if (f.look !== 'standing' || m.torn.has(f.head.caseId)) continue;
    m.torn.add(f.head.caseId);
    tear.add(f.head.caseId);
  }
  if (reduced) return { rise: false, ink: false, bind: false, inkScore: false, tear: new Set() };
  return { rise, ink, bind, inkScore, tear };
}

// ------------------------------------------------------------------ Apply

export type InkKey = 'reviewed' | 'fits' | 'written';
export const INK_ORDER: readonly InkKey[] = ['reviewed', 'fits', 'written'];
export const INK_LABEL: Record<InkKey, string> = { reviewed: 'Reviewed', fits: 'Fits', written: 'Written' };
export const INK_MEANING: Record<InkKey, string> = {
  reviewed: 'every selected case has a disposition',
  fits: 'both files within their allowances',
  written: 'every read-back matched',
};

/** The stamps that just turned inked, in order (Reviewed, Fits, Written): each inks once, only once verified. */
export function inkFresh(prev: ApplyView['stamps'] | null, next: ApplyView['stamps']): InkKey[] {
  return INK_ORDER.filter((k) => next[k] === 'inked' && (!prev || prev[k] !== 'inked'));
}

/** Apply's presentation memory: the stamps last painted, the undo last painted, the player's pane, the folds opened. */
export interface ApplyMemory {
  stamps: ApplyView['stamps'] | null;
  undo: string;
  result: string;
  chosen: 'diffs' | 'run' | null;
  open: Set<string>;
}

export function newApplyMemory(): ApplyMemory {
  return { stamps: null, undo: '', result: '', chosen: null, open: new Set() };
}

/**
 * What animates on this paint: the stamps that just turned inked (each once, in order) and the seal cracking once
 * after a successful Undo. A new write result resets the player's pane choice. Reduced motion: nothing animates.
 */
export function applyMotion(m: ApplyMemory, v: ApplyView, reduced: boolean): { fresh: InkKey[]; crack: boolean } {
  const result = v.result ? `${v.result.status}|${v.result.bundle ?? ''}` : '';
  if (result !== m.result) {
    m.result = result;
    m.chosen = null;
  }
  const fresh = inkFresh(m.stamps, v.stamps);
  m.stamps = v.stamps;
  const undo = v.undo?.status ?? '';
  const crack = undo === 'done' && m.undo !== 'done';
  m.undo = undo;
  return reduced ? { fresh: [], crack: false } : { fresh, crack };
}

export function busyText(busy: ApplyView['busy']): string | null {
  switch (busy) {
    case 'idle':
      return null;
    case 'granting':
      return 'Waiting for the folder…';
    case 'preparing':
      return 'Reading your files and building the diff…';
    case 'sealing':
      return 'Writing with backups, then reading every file back…';
    case 'undoing':
      return 'Restoring the original bytes…';
  }
}

export type BlockerAction = 'return' | 'reread' | 'grant';

/** What a blocker offers: grants for missing folders; "Read the files again" for a stale diff; the final campfire otherwise. */
export function blockerActions(b: Pick<ApplyBlockerView, 'kind'>): BlockerAction[] {
  switch (b.kind) {
    case 'grant':
      return ['grant'];
    case 'stale':
      return ['reread', 'return'];
    default:
      return ['return'];
  }
}

export const GRANT_LABEL: Record<'claude' | 'codex' | 'agents', string> = {
  claude: 'Choose your ~/.claude folder',
  codex: 'Choose your ~/.codex folder',
  agents: 'Choose your ~/.agents folder (Codex Skills)',
};

export const FILE_STATUS: Record<NonNullable<ApplyView['result']>['files'][number]['status'], string> = {
  'written-verified': 'written · read back',
  unchanged: 'unchanged',
  failed: 'failed',
  'not-attempted': 'not attempted',
};

export interface ApplyPlan {
  /** An async act is in flight: every control is disabled. */
  locked: boolean;
  busyText: string | null;
  grants: { which: 'claude' | 'codex' | 'agents'; label: string; optional: boolean }[];
  blockers: { kind: ApplyBlockerView['kind']; text: string; actions: BlockerAction[]; select: ApplyBlockerView['select'] }[];
  seal: boolean;
  undo: boolean;
  stamps: { key: InkKey; label: string; meaning: string; state: InkState }[];
  files: { path: string; text: string }[];
  /** The end summary leads once a write verified (the footer shows); the diffs lead before. */
  pane: 'diffs' | 'run';
}

export function applyPlan(v: ApplyView): ApplyPlan {
  const locked = v.busy !== 'idle';
  const grants = (['claude', 'codex', 'agents'] as const).filter((w) => v.needs[w]).map((which) => ({ which, label: GRANT_LABEL[which], optional: which === 'agents' }));
  return {
    locked,
    busyText: busyText(v.busy),
    grants,
    blockers: v.blockers.map((b) => ({ kind: b.kind, text: b.text, actions: blockerActions(b), select: b.select })),
    seal: v.canSeal && !locked,
    undo: v.canUndo && !locked,
    stamps: INK_ORDER.map((key) => ({ key, label: INK_LABEL[key], meaning: INK_MEANING[key], state: v.stamps[key] })),
    files: (v.result?.files ?? []).map((f) => ({ path: f.path, text: FILE_STATUS[f.status] })),
    pane: v.footer !== null ? 'run' : 'diffs',
  };
}

/** Diff rows with context: unchanged runs longer than 2·context fold into one row that can be opened. */
export type DiffRow = { kind: 'line'; op: 'same' | 'add' | 'del'; line: string } | { kind: 'fold'; from: number; to: number };

export function diffRows(ops: readonly { op: 'same' | 'add' | 'del'; line: string }[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  });
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (keep[i] || ops[i]!.op !== 'same') {
      rows.push({ kind: 'line', op: ops[i]!.op, line: ops[i]!.line });
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && !keep[j] && ops[j]!.op === 'same') j++;
    // A fold that hides a single line costs more than it saves: show it.
    if (j - i === 1) rows.push({ kind: 'line', op: 'same', line: ops[i]!.line });
    else rows.push({ kind: 'fold', from: i, to: j });
    i = j;
  }
  return rows;
}

export const OP_LABEL: Record<RunSummaryView['operations'][number]['kind'], string> = {
  add: 'added',
  fuse: 'fused',
  settle: 'settled',
  cut: 'cut',
  restore: 'restored',
  sharpen: 'sharpened',
  retarget: 're-targeted',
  swap: 'swapped',
};

export interface SummaryPlan {
  lines: string[];
  open: RunSummaryView['open'];
  openCount: number;
  setAside: { receipt: ReceiptView; label: string }[];
  notWritten: CardView[];
  /** Committed operations with a count, as "4 added"; empty when the run changed nothing at the fire. */
  operations: string[];
  files: { file: string; text: string; raised: string | null }[];
}

export function summaryPlan(s: RunSummaryView): SummaryPlan {
  return {
    lines: s.lines,
    open: s.open,
    openCount: s.openCount,
    setAside: s.setAside.map((x) => ({ receipt: x.receipt, label: stampLabel(x.disposition)! })),
    notWritten: s.notWritten,
    operations: s.operations.filter((o) => o.count > 0).map((o) => `${fmt(o.count)} ${OP_LABEL[o.kind]}`),
    files: s.files.map((f) => ({
      file: f.file,
      text: `${fmt(f.before)} → ${fmt(f.after)} of ${fmt(f.allowance)} · ${COPY.estimated}`,
      raised: f.raisedBy !== null ? `allowance raised to ${fmt(f.raisedBy)} by you` : null,
    })),
  };
}

// ------------------------------------------------------------------ the world plate (presentation geometry)

/** world-table.webp is 1536 × 1024; the shore (wood edge) lies at 63.3 % of its height, the lake's far edge at 56.2 %. */
export const PLATE = { ratio: 1536 / 1024, shore: 0.633, lake: 0.562 } as const;

/**
 * Where the world plate sits so its shore lands on bands.shoreY and it covers the viewport (cover, never stretched).
 * Returns the plate's box in viewport pixels; renderers subtract their band's top.
 */
export function plateBox(viewport: { w: number; h: number }, shoreY: number): { x: number; y: number; w: number; h: number } {
  const h = Math.max(viewport.w / PLATE.ratio, shoreY / PLATE.shore, (viewport.h - shoreY) / (1 - PLATE.shore), 1);
  const w = h * PLATE.ratio;
  return { x: Math.round((viewport.w - w) / 2), y: Math.round(shoreY - PLATE.shore * h), w: Math.round(w), h: Math.round(h) };
}
