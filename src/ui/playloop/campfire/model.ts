// Owner: campfire. Pure helpers for the campfire screen (play-loop §7, §0a.8–10, §0a.21): which proposal is on the
// table, which preview query it asks the api for, whether it may seal and with which call, the Enter and hold rules,
// and the plate and band geometry. No DOM, no adapter, no engine. Every game number stays in the views; the only maths
// here is presentation (rectangles, offsets, the plate's scale).

import type { Agent, Bands, CampfireView, CardView, ChangePreviewView, ControllerApi, DragPreview, GhostDelta, OpenPageView, SettleChoice, Targets, ThreadView, UiView } from '../contract';
import { AGENT_NAME, COPY, FILE_OF } from '../contract';

/** Sealing takes a 0.6 s hold on the seal, or Enter (§7). */
export const HOLD_MS = 600;
/** Stacklands snap: each card in a stack sits 22 px down and right of the one beneath (§7). */
export const STACK_OFFSET = 22;
/** The S card box, for the pair on phones (M comes from the bands). */
export const CARD_S = { w: 148, h: 207 } as const;
export const CARD_L = { w: 208, h: 291 } as const;
/** The cards' external Inspect control hangs this far above the face; rows of cards leave room for it. */
export const INSPECT_HEADROOM = 34;

// ------------------------------------------------------------------ proposals

/** Proposals the campfire starts itself, from the selected-card panel (no drop sets these). */
export type LocalEdit = { kind: 'sharpen'; cardId: string; text: string } | { kind: 'narrow'; cardId: string; targets: Targets };

export type SettleSlot = 'keep' | 'separate' | 'exception';
export type WhenKind = 'always' | 'project' | 'command' | 'path';

/** The player's choices in the four red-pair slots, kept per thread across repaints. */
export interface SettleDraft {
  slot: SettleSlot | null;
  keep: string;
  bind: string;
  projectKey: string | null;
  on: string;
  text: string;
  when: WhenKind;
  /** The project key for `project`, or the prefix for `command` and `path`. */
  whenValue: string;
}

/** A gold thread's editor: open when the thread has no automatic text, or when the player asked to edit it. */
export interface FuseDraft {
  editing: boolean;
  text: string;
}

export type Proposal =
  | { kind: 'fuse'; thread: ThreadView; top: string; under: string; members: string[]; editing: boolean; text: string }
  | { kind: 'settle'; thread: ThreadView; top: string; under: string; members: string[]; choice: SettleChoice | null }
  | { kind: 'cut'; cardId: string }
  | { kind: 'swap'; shelfId: string; deckId: string }
  | { kind: 'retarget'; cardId: string; targets: Targets; from: 'book' | 'chips' }
  | { kind: 'sharpen'; cardId: string; text: string }
  /** A stack whose thread is no longer in the view (another change dissolved it). */
  | { kind: 'gone'; top: string; under: string; members: string[] };

export type PreviewQuery = Parameters<ControllerApi['campfire']['changePreview']>[0];

export type SealCall =
  | { kind: 'fuse'; threadId: string; text: string }
  | { kind: 'settle'; threadId: string; choice: SettleChoice }
  | { kind: 'cut'; cardId: string }
  | { kind: 'swap'; shelfId: string; deckId: string }
  | { kind: 'retarget'; cardId: string; targets: Targets }
  | { kind: 'sharpen'; cardId: string; text: string };

export interface Drafts {
  fuse: Record<string, FuseDraft>;
  settle: Record<string, SettleDraft>;
  edit: LocalEdit | null;
}

/** Every card the campfire can show by id: the three lanes, the shelf and the ash list. */
export function cardIndex(v: CampfireView): Map<string, CardView> {
  const m = new Map<string, CardView>();
  for (const c of [...v.lanes.claude, ...v.lanes.both, ...v.lanes.codex, ...v.piles.shelf, ...v.ash]) if (!m.has(c.id)) m.set(c.id, c);
  return m;
}

/** The deck cards at the fire (the three lanes), never the shelf or the ash. */
export function deckIds(v: CampfireView): Set<string> {
  return new Set([...v.lanes.claude, ...v.lanes.both, ...v.lanes.codex].map((c) => c.id));
}

/** The editor's starting text for a gold thread: its automatic text, or every member's line, one per row. */
export function initialFuseText(thread: ThreadView, cards: Map<string, CardView>): string {
  if (thread.autoText) return thread.autoText;
  return thread.members.map((id) => cards.get(id)?.inspector.exact ?? '').filter((t) => t.length > 0).join('\n');
}

/** A written line is one non-empty line: the file takes one bullet per card. */
export function oneLine(text: string): boolean {
  return text.trim().length > 0 && !/[\r\n]/.test(text.trim());
}

export function defaultSettle(thread: ThreadView, projects: CampfireView['projects']): SettleDraft {
  const first = thread.members[0] ?? '';
  return { slot: null, keep: first, bind: first, projectKey: projects[0]?.key ?? null, on: first, text: '', when: 'always', whenValue: '' };
}

/** The engine's settlement for the draft, or null while the chosen slot is incomplete. Cancel is not a choice here: it calls cancel(). */
export function settleChoice(d: SettleDraft, thread: ThreadView, projects: CampfireView['projects']): SettleChoice | null {
  const member = (id: string) => thread.members.includes(id);
  switch (d.slot) {
    case 'keep':
      return member(d.keep) ? { kind: 'keep', keep: d.keep } : null;
    case 'separate': {
      const p = projects.find((x) => x.key === d.projectKey);
      return member(d.bind) && p ? { kind: 'separate', bind: d.bind, projectKey: p.key, projectLabel: p.label } : null;
    }
    case 'exception': {
      const text = d.text.trim();
      if (!member(d.on) || !oneLine(text)) return null;
      const v = d.whenValue.trim();
      // A chosen condition must be complete: an empty prefix or an unknown project is no choice, never "always".
      if (d.when === 'always') return { kind: 'exception', on: d.on, text, when: {} };
      if (d.when === 'project') return projects.some((x) => x.key === v) ? { kind: 'exception', on: d.on, text, when: { projectKey: v } } : null;
      if (!v) return null;
      return { kind: 'exception', on: d.on, text, when: d.when === 'command' ? { commandPrefix: v } : { pathPrefix: v } };
    }
    default:
      return null;
  }
}

/**
 * The proposal on the table. A drop (ui.pending) wins over a campfire-started edit. A stack proposes its whole thread:
 * gold is a fuse, red a settlement. A pending 'confirm' belongs to rooms and is ignored here.
 */
export function proposalOf(v: CampfireView, pending: UiView['pending'], drafts: Drafts): Proposal | null {
  const cards = cardIndex(v);
  if (pending) {
    switch (pending.kind) {
      case 'stack': {
        const t = v.threads.find((x) => x.id === pending.threadId);
        const members = t ? t.members : pending.members;
        if (!t) return { kind: 'gone', top: pending.a, under: pending.b, members };
        if (t.color === 'gold') {
          const d = drafts.fuse[t.id];
          const editing = !t.autoText || !!d?.editing;
          const text = editing ? (d?.text ?? initialFuseText(t, cards)) : (t.autoText ?? '');
          return { kind: 'fuse', thread: t, top: pending.a, under: pending.b, members, editing, text };
        }
        const d = drafts.settle[t.id] ?? defaultSettle(t, v.projects);
        return { kind: 'settle', thread: t, top: pending.a, under: pending.b, members, choice: settleChoice(d, t, v.projects) };
      }
      case 'cut':
        return { kind: 'cut', cardId: pending.cardId };
      case 'swap':
        return { kind: 'swap', shelfId: pending.shelfId, deckId: pending.deckId };
      case 'retarget':
        return { kind: 'retarget', cardId: pending.cardId, targets: pending.targets, from: 'book' };
      default:
        return null;
    }
  }
  const e = drafts.edit;
  if (!e || !deckIds(v).has(e.cardId)) return null;
  return e.kind === 'sharpen' ? { kind: 'sharpen', cardId: e.cardId, text: e.text } : { kind: 'retarget', cardId: e.cardId, targets: e.targets, from: 'chips' };
}

/** What to ask the api's changePreview for, or null when nothing can be previewed yet (no text, no slot). */
export function queryOf(p: Proposal): PreviewQuery | null {
  switch (p.kind) {
    case 'fuse':
      if (!p.editing) return { threadId: p.thread.id };
      return oneLine(p.text) ? { threadId: p.thread.id, text: p.text.trim() } : null;
    case 'settle':
      return p.choice && p.choice.kind !== 'cancel' ? { threadId: p.thread.id, settle: p.choice } : null;
    case 'cut':
      return { cutId: p.cardId };
    case 'swap':
      return { swap: { shelfId: p.shelfId, deckId: p.deckId } };
    case 'retarget':
      return { retarget: { cardId: p.cardId, targets: p.targets } };
    case 'sharpen':
      return oneLine(p.text) ? { sharpen: { cardId: p.cardId, text: p.text.trim() } } : null;
    case 'gone':
      return null;
  }
}

/**
 * Whether the proposal may seal, with the api call that performs it. No preview, or a preview with `refused`, never
 * seals; `why` says what is missing in the player's words.
 */
export function sealOf(p: Proposal, preview: ChangePreviewView | null): { call: SealCall | null; why: string | null } {
  if (p.kind === 'gone') return { call: null, why: 'These cards no longer share a thread. Pull them apart.' };
  if (!preview) {
    const why =
      p.kind === 'fuse' ? 'Write the merged line on one line to see it.' : p.kind === 'settle' ? 'Pick how to settle the pair, and complete its fields.' : p.kind === 'sharpen' ? 'Write the line on one line to see it.' : 'No preview for this change.';
    return { call: null, why };
  }
  if (preview.refused) return { call: null, why: preview.refused };
  switch (p.kind) {
    case 'fuse':
      return { call: { kind: 'fuse', threadId: p.thread.id, text: p.editing ? p.text.trim() : (p.thread.autoText ?? p.text) }, why: null };
    case 'settle':
      return p.choice && p.choice.kind !== 'cancel' ? { call: { kind: 'settle', threadId: p.thread.id, choice: p.choice }, why: null } : { call: null, why: 'Pick how to settle the pair, and complete its fields.' };
    case 'cut':
      return { call: { kind: 'cut', cardId: p.cardId }, why: null };
    case 'swap':
      return { call: { kind: 'swap', shelfId: p.shelfId, deckId: p.deckId }, why: null };
    case 'retarget':
      return { call: { kind: 'retarget', cardId: p.cardId, targets: p.targets }, why: null };
    case 'sharpen':
      return { call: { kind: 'sharpen', cardId: p.cardId, text: p.text.trim() }, why: null };
  }
}

/** Perform a seal through the api. The only place the campfire commits a change. */
export function runSeal(api: ControllerApi, call: SealCall): void {
  switch (call.kind) {
    case 'fuse':
      return api.campfire.fuse(call.threadId, call.text);
    case 'settle':
      return api.campfire.settle(call.threadId, call.choice);
    case 'cut':
      return api.campfire.cut(call.cardId);
    case 'swap':
      return api.campfire.swap(call.shelfId, call.deckId);
    case 'retarget':
      return api.campfire.retarget(call.cardId, call.targets);
    case 'sharpen':
      return api.campfire.sharpen(call.cardId, call.text);
  }
}

/** The proposal's name on the panel and the seal's verb. */
export function proposalTitle(p: Proposal): { title: string; seal: string } {
  switch (p.kind) {
    case 'fuse':
      return { title: 'Merge the gold thread', seal: 'Seal the merge' };
    case 'settle':
      return { title: 'Settle the red pair', seal: 'Seal the settlement' };
    case 'cut':
      return { title: 'Into the fire', seal: 'Burn it' };
    case 'swap':
      return { title: 'Swap from the shelf', seal: 'Seal the swap' };
    case 'retarget':
      return { title: p.targets === 'both' ? 'Write it to both files' : `Keep it in ${FILE_OF[p.targets]} only`, seal: 'Seal the change' };
    case 'sharpen':
      return { title: 'Sharpen the wording', seal: 'Seal the new wording' };
    case 'gone':
      return { title: 'The thread is gone', seal: 'Seal' };
  }
}

/** The DragPreview the books read for their strap ghost while a change is proposed (the api's numbers, reshaped). */
export function strapPreview(p: Proposal | null, preview: ChangePreviewView | null): DragPreview | null {
  if (!p || !preview || p.kind === 'gone') return null;
  const verb: DragPreview['verb'] =
    p.kind === 'fuse' ? 'fuse' : p.kind === 'settle' ? 'settle' : p.kind === 'cut' ? 'cut' : p.kind === 'swap' ? 'swap' : p.kind === 'retarget' ? (p.targets === 'both' ? 'widen' : 'narrow') : 'none';
  return { verb, heads: [], ghost: preview.ghost, line: null, accepts: [], refused: preview.refused };
}

// ------------------------------------------------------------------ input: Enter, Escape and the hold

/** Where a key landed: the seal control, another control of ours, one of our text fields, a field elsewhere, or anything else. */
export type KeyTarget = 'seal' | 'control' | 'field' | 'outside-field' | 'other';

export function keyTarget(tag: string | undefined, isSeal: boolean, inside: boolean): KeyTarget {
  const t = (tag ?? '').toUpperCase();
  const field = t === 'INPUT' || t === 'TEXTAREA';
  if (!inside) return field ? 'outside-field' : 'other';
  if (isSeal) return 'seal';
  if (field) return 'field';
  if (t === 'BUTTON' || t === 'SELECT' || t === 'A') return 'control';
  return 'other';
}

/**
 * Enter at the campfire. seal = perform the proposal; block = swallow it (a proposal is up but cannot seal, so Enter must
 * not leave the campfire); own = let our focused control act and keep the key from the controller; pass = the
 * controller's Enter (leave the campfire when nothing is proposed).
 */
export function enterAction(x: { proposal: boolean; sealable: boolean; target: KeyTarget }): 'seal' | 'block' | 'own' | 'pass' {
  if (x.target === 'outside-field') return 'pass';
  if (x.target === 'control') return 'own';
  if (x.proposal) return x.sealable ? 'seal' : 'block';
  return x.target === 'field' ? 'own' : 'pass';
}

export type Hold = { kind: 'idle' } | { kind: 'holding'; t0: number };
export const HOLD_IDLE: Hold = { kind: 'idle' };

/** The seal's press: a hold of HOLD_MS seals; letting go earlier only lets go. Pure, so the timing is testable. */
export function holdStep(h: Hold, e: { type: 'down'; t: number; sealable: boolean } | { type: 'tick'; t: number } | { type: 'up'; t: number } | { type: 'cancel' }): [Hold, boolean] {
  switch (e.type) {
    case 'down':
      return [e.sealable ? { kind: 'holding', t0: e.t } : HOLD_IDLE, false];
    case 'tick':
      return h.kind === 'holding' && e.t - h.t0 >= HOLD_MS ? [HOLD_IDLE, true] : [h, false];
    case 'up':
      return [HOLD_IDLE, h.kind === 'holding' && e.t - h.t0 >= HOLD_MS];
    case 'cancel':
      return [HOLD_IDLE, false];
  }
}

// ------------------------------------------------------------------ words

export const LANE_TABS: readonly { tab: 'claude' | 'both' | 'codex'; label: string }[] = [
  { tab: 'claude', label: AGENT_NAME.claude },
  { tab: 'both', label: 'Both' },
  { tab: 'codex', label: AGENT_NAME.codex },
];

/** One weight row per lane from the api's ghost: "CLAUDE.md", "172 → 153", "−19", with COPY.estimated beside it. */
export function weightRows(ghost: { claude: GhostDelta; codex: GhostDelta }): { file: string; span: string; delta: string; estimated: string }[] {
  return (['claude', 'codex'] as const).map((a) => ({ file: FILE_OF[a], span: `${ghost[a].before} → ${ghost[a].after}`, delta: ghost[a].text, estimated: COPY.estimated }));
}

/** The hover line while a card is dragged over a campfire target: what release would propose (nothing is changed). */
export function hoverLine(d: UiView['drag']): string | null {
  if (!d || !d.target || !d.preview) return null;
  if (d.preview.refused) return d.preview.refused;
  switch (d.preview.verb) {
    case 'fuse':
      return 'Release to stack them: the merge is proposed, nothing changes yet.';
    case 'settle':
      return 'Release to stack the red pair and choose how to settle it.';
    case 'cut':
      return 'Release over the fire to see what a cut frees and reopens.';
    case 'swap':
      return 'Release to propose the swap from the shelf.';
    case 'widen':
      return 'Release on the book to propose writing it to both files.';
    case 'narrow':
      return 'Release to propose keeping it in one file.';
    default:
      return null;
  }
}

/** A case's tag in words when the view carries it (an Open page or the pinned page), else null. */
export function caseTag(caseId: string, v: CampfireView, refs: readonly { caseId: string; agent: Agent; project: string | null; date: string | null }[] = []): string | null {
  // A preview names its own cases (ChangePreviewView.refs); otherwise an Open page or the pinned receipt does.
  const ref = refs.find((r) => r.caseId === caseId);
  if (ref) return tagText(ref);
  const page: OpenPageView | undefined = v.piles.open.find((p) => p.caseId === caseId) ?? (v.pinned?.caseId === caseId ? v.pinned : undefined);
  if (!page) return null;
  return tagText(page.tag);
}

export function tagText(t: { agent: Agent; project: string | null; date: string | null }): string {
  return [AGENT_NAME[t.agent], t.project ?? 'no project', t.date ?? 'no date'].join(' · ');
}

/** Words for a card's files: "CLAUDE.md", "AGENTS.md" or both. */
export function filesOf(t: Targets): string {
  return t === 'both' ? `${FILE_OF.claude} and ${FILE_OF.codex}` : FILE_OF[t];
}

/** Split a log string into text and backtick code spans (rendered as <code> by the screen, never as HTML). */
export function codeSpans(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

// ------------------------------------------------------------------ geometry

/** The campfire plate (plates/campfire.png, 1536 × 1024): the table edge and the candle, measured in plate pixels. */
export const PLATE = { w: 1536, h: 1024, edgeY: 765, candleX: 446, dishTop: 805 } as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CampfireGeometry {
  mode: Bands['mode'];
  /** Stage = sky + creature (the creature collapses at the fire); wood = the wood band. Heights from the bands. */
  stage: { h: number; pad: number; bottom: number; cols: [number, number] | null };
  wood: { h: number; pad: number; gap: number; books: number; piles: number };
  /** The lane strip in the wood (x, width) and the tabs above it; the fire's box, both in band coordinates. */
  lane: { x: number; w: number };
  fire: Rect;
  /** The pair's card box: M on desktop and tablet, S on phones (M is the minimum only at widths ≥ 600). */
  pairCard: { size: 'S' | 'M'; w: number; h: number };
  /** The plate as a background over both bands: one size, one offset per band, so the table edge meets the shore. */
  plate: { w: number; h: number; stage: { x: number; y: number }; wood: { x: number; y: number } };
}

/**
 * Lay the campfire into the bands. Books keep their room column on the left, the fire sits over the candle's pool,
 * the lane strip takes the middle and the piles keep the right. On phones the lane is a carousel above the book tabs,
 * and the fire shares the bottom rail with the piles. The plate is scaled so its table edge meets the shore line, it
 * covers both bands, and the candle stands under the fire.
 */
export function campfireGeometry(b: Bands): CampfireGeometry {
  const W = b.viewport.w;
  const stageH = b.sky.h + b.creature.h;
  const woodH = b.wood.h;
  let fire: Rect;
  let lane: { x: number; w: number };
  let stage: CampfireGeometry['stage'];
  let wood: CampfireGeometry['wood'];
  let pairCard: CampfireGeometry['pairCard'];
  if (b.mode === 'phone') {
    const pad = 16;
    const row = W - 2 * pad;
    const half = Math.floor((row - b.touch.gap) / 2);
    const top = INSPECT_HEADROOM;
    const railY = top + b.card.h + 8 + b.touch.min + 8;
    fire = { x: pad + half + b.touch.gap, y: railY, w: row - half - b.touch.gap, h: b.touch.min };
    lane = { x: pad, w: row };
    stage = { h: stageH, pad, bottom: b.touch.min + 12, cols: null };
    wood = { h: woodH, pad, gap: b.touch.gap, books: row, piles: half };
    pairCard = { size: 'S', ...CARD_S };
  } else {
    const desktop = b.mode === 'desktop';
    const pad = b.margin / 2;
    const gap = desktop ? 24 : 16;
    const books = 2 * b.books.w + b.books.gap;
    const piles = 2 * b.piles.w + b.piles.gap;
    const fireW = desktop ? 168 : 128;
    const fireX = pad + books + gap;
    lane = { x: fireX + fireW + gap, w: W - (fireX + fireW + gap) - gap - piles - pad };
    stage = { h: stageH, pad, bottom: b.touch.min + 12, cols: desktop ? [books, 440] : [220, 340] };
    wood = { h: woodH, pad, gap, books, piles };
    pairCard = { size: 'M', w: b.card.w, h: b.card.h };
    fire = { x: fireX, y: 0, w: fireW, h: 0 };
  }
  const fx = fire.x + fire.w / 2;
  const s = Math.max(stageH / PLATE.edgeY, woodH / (PLATE.h - PLATE.edgeY), fx / PLATE.candleX, (W - fx) / (PLATE.w - PLATE.candleX));
  const pw = Math.ceil(PLATE.w * s);
  const ph = Math.ceil(PLATE.h * s);
  const x0 = Math.round(fx - PLATE.candleX * s);
  const edge = PLATE.edgeY * s;
  if (b.mode !== 'phone') {
    const top = Math.max(8, Math.round((PLATE.dishTop - PLATE.edgeY) * s) - 10);
    fire = { ...fire, y: top, h: Math.max(b.touch.min, woodH - 12 - top) };
  }
  return {
    mode: b.mode,
    stage,
    wood,
    lane,
    fire,
    pairCard,
    plate: { w: pw, h: ph, stage: { x: x0, y: Math.round(stageH - edge) }, wood: { x: x0, y: Math.round(-edge) } },
  };
}

/** The stack's offset: 22 px when it fits, tighter (never under 10) when the stage is short. */
export function stackOffset(n: number, room: number, cardH: number): number {
  if (n <= 1) return 0;
  return Math.max(10, Math.min(STACK_OFFSET, Math.floor((room - cardH) / (n - 1))));
}

/** Bottom-to-top order of a stack: the other members, then the card dropped on, then the card dropped (on top). */
export function stackOrder(members: string[], top: string, under: string): string[] {
  const rest = members.filter((m) => m !== top && m !== under);
  return [...rest, ...(under !== top ? [under] : []), top];
}
