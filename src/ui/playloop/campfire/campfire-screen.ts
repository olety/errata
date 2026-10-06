// Owner: campfire. The campfire screen (play-loop §7, §0a.8–10, §0a.21). Stacking proposes, sealing performs: a drop
// only sets ui.pending, every change shows the api's preview, and only a 0.6 s hold on the seal or Enter calls the
// matching act. Cancel (Escape, Pull apart, or dragging the top card off) leaves the thread. Imports ../contract and
// ../cards only; every number on screen is a view field.
import './campfire.css';
import type { CampfireView, CardView, ChangePreviewView, ScreenProps, ThreadView } from '../contract';
import { COPY, FILE_OF } from '../contract';
import { Books, Card, Piles } from '../cards';
import * as M from './model';

type Kid = Node | string | null | false | undefined;

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/** Text with backtick spans as <code> built from textContent. Exact lines keep their backticks visible. */
function inline(text: string, ticks = false): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const s of M.codeSpans(text)) {
    if (!s.code) f.append(document.createTextNode(s.text));
    else {
      const c = document.createElement('code');
      c.textContent = ticks ? `\`${s.text}\`` : s.text;
      f.append(c);
    }
  }
  return f;
}

function button(label: Kid | Kid[], cls: string, onClick: () => void, opts: { pressed?: boolean; fk?: string; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  const b = el('button', `pl-campfire-btn ${cls}`.trim(), ...(Array.isArray(label) ? label : [label]));
  b.type = 'button';
  if (opts.pressed !== undefined) b.setAttribute('aria-pressed', String(opts.pressed));
  if (opts.fk) b.dataset.fk = opts.fk;
  if (opts.disabled) b.disabled = true;
  if (opts.title) b.title = opts.title;
  b.addEventListener('click', onClick);
  return b;
}

const px = (n: number) => `${n}px`;
const PLATE_URL = `${import.meta.env.BASE_URL}playloop/campfire/campfire.png`;

// ------------------------------------------------------------------ presentation state (never game state)

/** Drafts survive repaints: the merged text being written, the chosen settlement slots, a sharpen or narrow edit. */
const drafts: M.Drafts = { fuse: {}, settle: {}, edit: null };

interface AfterSeal {
  resultId: string;
  text: string;
  cases: string[];
  /** Cases a later accept effect bound (ui.effect.bound), so the row says so. */
  bound: Set<string>;
  seen: number;
  /** Tags seen while a case was on the Open pile, kept once it leaves it. */
  labels: Record<string, string>;
  /** Cases whose accept this panel sent and a fresh accept effect confirmed (the state changed). */
  accepted: Set<string>;
  /** The case whose accept was sent last, waiting for its effect. */
  sent: string | null;
}

/** The seal a hold started on: it completes only while that same proposal is still on the table and on screen. */
let holdOn: { key: string | null; button: HTMLElement } | null = null;

const local: {
  side: 'shelf' | 'ash' | 'open';
  after: AfterSeal | null;
  reopened: { id: number; cases: string[] } | null;
  lastSeal: { kind: M.SealCall['kind']; cardId: string | null; before: number } | null;
  animated: Set<number>;
  snapKey: string | null;
  hold: M.Hold;
  holdTimer: ReturnType<typeof setTimeout> | null;
} = { side: 'shelf', after: null, reopened: null, lastSeal: null, animated: new Set(), snapKey: null, hold: M.HOLD_IDLE, holdTimer: null };

interface Live {
  p: ScreenProps<CampfireView>;
  geo: M.CampfireGeometry;
  cards: Map<string, CardView>;
  stage: HTMLElement;
  wood: HTMLElement;
  booksHost: HTMLElement;
  proposal: M.Proposal | null;
  preview: ChangePreviewView | null;
  seal: { call: M.SealCall | null; why: string | null };
  /** The hosts a text edit refreshes without rebuilding the editor. */
  resultHost: HTMLElement | null;
  detailHost: HTMLElement | null;
  sealHosts: HTMLElement[];
  anim: { kind: string; cardId: string | null } | null;
  snap: boolean;
}

let live: Live | null = null;
let owner: ScreenProps<CampfireView>['api'] | null = null;

function compute(L: Pick<Live, 'p' | 'proposal' | 'preview' | 'seal'>): void {
  const v = L.p.view;
  L.proposal = M.proposalOf(v, L.p.ui.pending, drafts);
  const q = L.proposal ? M.queryOf(L.proposal) : null;
  L.preview = q ? L.p.api.campfire.changePreview(q) : null;
  L.seal = L.proposal ? M.sealOf(L.proposal, L.preview) : { call: null, why: null };
}

// ------------------------------------------------------------------ keys: Enter seals, Escape cancels

let keysInstalled = false;
function installKeys(): void {
  if (keysInstalled || typeof window === 'undefined') return;
  keysInstalled = true;
  // Capture phase: runs before the mount's keydown, so Enter with a proposal up seals instead of leaving the campfire.
  window.addEventListener('keydown', onKey, true);
}

function onKey(e: KeyboardEvent): void {
  const L = live;
  if (!L || !L.stage.isConnected) return;
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  if (e.isComposing || e.keyCode === 229) return;
  const t = e.target instanceof HTMLElement ? e.target : null;
  const inside = !!t && (L.stage.contains(t) || L.wood.contains(t));
  const kt = M.keyTarget(t?.tagName, t?.dataset.role === 'seal', inside);
  if (e.key === 'Escape') {
    if (kt === 'outside-field') return;
    drafts.edit = null;
    holdReset();
    // The mount ignores keys typed in fields; cancel here so Escape works from the editor too.
    if (kt === 'field') {
      e.preventDefault();
      e.stopPropagation();
      L.p.api.cancel();
    }
    return;
  }
  const act = M.enterAction({ proposal: !!L.proposal, sealable: !!L.seal.call, target: kt });
  if (act === 'pass') return;
  e.stopPropagation();
  if (act === 'own') return;
  e.preventDefault();
  if (act === 'seal') doSeal();
  else for (const h of L.sealHosts) h.querySelector('.pl-campfire-why')?.classList.add('is-flagged');
}

function holdReset(): void {
  if (local.holdTimer) clearTimeout(local.holdTimer);
  local.holdTimer = null;
  local.hold = M.HOLD_IDLE;
  holdOn?.button.classList.remove('is-holding');
  holdOn = null;
}

/** A hold completes only on the button it began on, still connected, with the same proposal on the table. */
function holdSeal(): void {
  const h = holdOn;
  holdReset();
  if (!h || !h.button.isConnected || !live || snapKeyOf(live.proposal) !== h.key) return;
  doSeal();
}

/** Perform the proposal on the table: the only path from the campfire to a committing act. */
function doSeal(): void {
  const L = live;
  if (!L || !L.stage.isConnected || !L.proposal || !L.seal.call) return;
  holdReset();
  const call = L.seal.call;
  const pv = L.preview;
  const p = L.proposal;
  const fxId = L.p.ui.effect?.id ?? 0;
  // A new text binds nothing until accepted: remember its cases so the panel can offer acceptMapping after the seal.
  local.after = (call.kind === 'fuse' || call.kind === 'sharpen') && pv?.resultId && pv.needsAcceptance.length > 0 ? { resultId: pv.resultId, text: pv.after?.text ?? '', cases: [...pv.needsAcceptance], bound: new Set(), seen: fxId, labels: {}, accepted: new Set(), sent: null } : null;
  local.reopened = null;
  const cardId = call.kind === 'fuse' || call.kind === 'sharpen' ? (pv?.resultId ?? null) : call.kind === 'swap' ? call.shelfId : call.kind === 'settle' ? null : call.cardId;
  local.lastSeal = { kind: call.kind, cardId, before: fxId };
  if (p.kind === 'fuse') delete drafts.fuse[p.thread.id];
  if (p.kind === 'settle') delete drafts.settle[p.thread.id];
  drafts.edit = null;
  M.runSeal(L.p.api, call);
}

function cancelProposal(): void {
  drafts.edit = null;
  holdReset();
  live?.p.api.cancel();
}

// ------------------------------------------------------------------ focus and scroll across repaints

function focusMark(): { fk: string; start: number | null; end: number | null } | null {
  const a = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  if (!a || !live || !(live.stage.contains(a) || live.wood.contains(a))) return null;
  const fk = a.dataset.fk;
  if (!fk) return null;
  if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) return { fk, start: a.selectionStart, end: a.selectionEnd };
  // A mouse click leaves focus on a button; only keyboard focus follows the repaint, so Enter still seals after a click.
  return a.matches(':focus-visible') ? { fk, start: null, end: null } : null;
}

function scrollMarks(): Record<string, number> {
  const out: Record<string, number> = {};
  if (!live) return out;
  for (const r of [live.stage, live.wood]) r.querySelectorAll<HTMLElement>('[data-sk]').forEach((e) => (out[e.dataset.sk!] = e.dataset.sk!.startsWith('x:') ? e.scrollLeft : e.scrollTop));
  return out;
}

function restore(roots: HTMLElement[], focus: ReturnType<typeof focusMark>, scrolls: Record<string, number>): void {
  queueMicrotask(() => {
    for (const r of roots) {
      r.querySelectorAll<HTMLElement>('[data-sk]').forEach((e) => {
        const v = scrolls[e.dataset.sk!];
        if (v === undefined) return;
        if (e.dataset.sk!.startsWith('x:')) e.scrollLeft = v;
        else e.scrollTop = v;
      });
    }
    if (!focus) return;
    for (const r of roots) {
      const e = r.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focus.fk)}"]`);
      if (!e || !e.isConnected) continue;
      e.focus({ preventScroll: true });
      if ((e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement) && focus.start !== null) e.setSelectionRange(focus.start, focus.end ?? focus.start);
      return;
    }
  });
}

/** Rebuild the stage after a campfire-only change (a slot, an editor opening); the wood keeps its bindings. */
function rerender(): void {
  const L = live;
  if (!L || !L.stage.isConnected) return;
  holdReset();
  const f = focusMark();
  const s = scrollMarks();
  compute(L);
  fillStage(L);
  refreshBooks(L);
  restore([L.stage], f, s);
}

/** A keystroke in an editor: new preview, new seal state, new strap ghost. The editor itself stays. */
function refresh(): void {
  const L = live;
  if (!L || !L.stage.isConnected) return;
  holdReset();
  compute(L);
  if (L.resultHost) L.resultHost.replaceChildren(previewPart(L, 'result'));
  if (L.detailHost) L.detailHost.replaceChildren(previewPart(L, 'detail'));
  for (const h of L.sealHosts) h.replaceChildren(...sealBarKids(L).filter((k): k is Node | string => !!k));
  refreshBooks(L);
}

function refreshBooks(L: Live): void {
  const { view: v, ui, drag } = L.p;
  L.booksHost.replaceChildren(Books({ books: v.books, preview: ui.drag?.preview ?? M.strapPreview(L.proposal, L.preview), mode: 'retarget', layout: ui.bands.books.mode, drag }));
}

// ------------------------------------------------------------------ the screen

/**
 * The campfire (§7, §0a.21): lane tabs (Claude / Both / Codex) and one focused pair, gold and red threads with their
 * reasons, stack to propose and seal to perform (ui.pending), the fire to cut, the books to re-target, the ash list to
 * restore. Returns the stage band (focused pair, threads, seal preview) and the wood band (lane cards, fire, books, piles).
 */
export function CampfireScreen(p: ScreenProps<CampfireView>): { stage: HTMLElement; wood: HTMLElement } {
  installKeys();
  holdReset();
  // Presentation state belongs to one run: a new controller (a new run) starts clean, effect ids included.
  if (owner !== p.api) {
    owner = p.api;
    drafts.fuse = {};
    drafts.settle = {};
    drafts.edit = null;
    Object.assign(local, { side: 'shelf', after: null, reopened: null, lastSeal: null, animated: new Set<number>(), snapKey: null });
    live = null;
  }
  const focus = focusMark();
  const scrolls = scrollMarks();
  const v = p.view;
  const geo = M.campfireGeometry(p.ui.bands);
  if (p.ui.pending) drafts.edit = null;
  const fx = p.ui.effect;
  // Exactly-once effects: a seal's wax or burn, an accept binding a case, a cut reopening cases.
  let anim: Live['anim'] = null;
  if (fx && !local.animated.has(fx.id)) {
    local.animated.add(fx.id);
    // Any later committed change (a restore, an accept, another seal) retires the "the cut reopened" note.
    if (local.reopened && fx.id > local.reopened.id) local.reopened = null;
    if (local.lastSeal && fx.id > local.lastSeal.before) {
      if (!p.ui.reducedMotion) anim = { kind: fx.kind, cardId: local.lastSeal.cardId };
      if (fx.kind === 'cut' && fx.unbound.length > 0) local.reopened = { id: fx.id, cases: [...fx.unbound] };
      local.lastSeal = null;
    }
    if (local.after && fx.kind === 'accept' && fx.id > local.after.seen) {
      // A fresh accept effect means the act changed the state: the mapping is accepted, whether or not coverage flipped.
      if (local.after.sent) local.after.accepted.add(local.after.sent);
      local.after.sent = null;
      for (const id of fx.bound) if (local.after.cases.includes(id)) local.after.bound.add(id);
      local.after.seen = fx.id;
    }
  }
  const stage = el('section', `pl-campfire-stage pl-campfire-${geo.mode}`);
  const wood = el('div', `pl-campfire-wood pl-campfire-wood-${geo.mode}`);
  for (const [node, off, h] of [[stage, geo.plate.stage, geo.stage.h] as const, [wood, geo.plate.wood, geo.wood.h] as const]) {
    node.style.height = px(h);
    node.style.backgroundImage = `url("${PLATE_URL}")`;
    node.style.backgroundSize = `${px(geo.plate.w)} ${px(geo.plate.h)}`;
    node.style.backgroundPosition = `${px(off.x)} ${px(off.y)}`;
  }
  const L: Live = { p, geo, cards: M.cardIndex(v), stage, wood, booksHost: el('div', 'pl-campfire-books'), proposal: null, preview: null, seal: { call: null, why: null }, resultHost: null, detailHost: null, sealHosts: [], anim, snap: false };
  compute(L);
  if (L.proposal) local.after = null;
  if (L.proposal) local.reopened = null;
  const key = snapKeyOf(L.proposal);
  L.snap = !!key && key !== local.snapKey && !p.ui.reducedMotion;
  local.snapKey = key;
  live = L;
  fillStage(L);
  fillWood(L);
  restore([stage, wood], focus, scrolls);
  return { stage, wood };
}

function snapKeyOf(p: M.Proposal | null): string | null {
  if (!p) return null;
  if (p.kind === 'fuse' || p.kind === 'settle' || p.kind === 'gone') return `stack:${p.top}:${p.under}`;
  if (p.kind === 'swap') return `swap:${p.shelfId}:${p.deckId}`;
  return `${p.kind}:${'cardId' in p ? p.cardId : ''}`;
}

/** The seal preview for a pending stack, settlement, cut, swap or re-target, read from ui.pending. */
export function SealPreview(p: { preview: ChangePreviewView | null }): HTMLElement {
  const ctx: PreviewCtx = { title: () => null, caseLabel: () => null, onCase: null, empty: 'Nothing is proposed.' };
  return el('div', 'pl-campfire-sealpreview', resultPart(p.preview, ctx), detailPart(p.preview, ctx));
}

// ------------------------------------------------------------------ the stage band

function fillStage(L: Live): void {
  const { geo } = L;
  L.sealHosts = [];
  L.resultHost = null;
  L.detailHost = null;
  const kids: HTMLElement[] = [];
  if (geo.mode === 'phone') {
    const scroll = el('div', 'pl-campfire-scroll', centre(L), side(L), threadsPanel(L));
    scroll.dataset.sk = 'y:phone';
    scroll.style.height = px(geo.stage.h - geo.stage.bottom);
    kids.push(scroll, bottomRow(L));
  } else {
    // The side panel runs to the stage's foot; the threads and the pair stop above the lane tabs and Leave.
    const left = threadsPanel(L);
    const mid = centre(L);
    left.style.marginBottom = px(geo.stage.bottom - 6);
    mid.style.marginBottom = px(geo.stage.bottom - 6);
    const cols = el('div', 'pl-campfire-cols', left, mid, side(L));
    cols.style.gridTemplateColumns = `${px(geo.stage.cols![0])} minmax(0, 1fr) ${px(geo.stage.cols![1])}`;
    cols.style.height = px(geo.stage.h - 6);
    cols.style.padding = `12px ${px(geo.stage.pad)} 0`;
    kids.push(cols, bottomRow(L));
  }
  L.stage.replaceChildren(...kids);
}

function cardTitle(L: Live, id: string): string {
  const c = L.cards.get(id);
  return c ? c.face.title : 'A card';
}

function summaryOf(L: Live, id: string): DocumentFragment | string {
  const c = L.cards.get(id);
  return c ? inline(c.face.summary) : 'A card';
}

/** One rendering of a card at the fire. Target ids are unique per rendered instance (card:<id>:<where>). */
function cardSlot(L: Live, card: CardView, where: string, opts: { size: 'S' | 'M' | 'L'; source: boolean; target: boolean; cls?: string }): HTMLElement {
  const { ui, api, drag, view: v } = L.p;
  const node = Card({ card, size: opts.size, selected: ui.selected === card.id, drag: opts.source ? drag : null, onInspect: (id) => api.inspect({ cardId: id }) });
  const eligible = v.pinned ? v.pinnedCandidates.some((c) => c.cardId === card.id && c.glow) : false;
  const slot = el('div', `pl-campfire-slot pl-campfire-slot-${opts.size}${eligible ? ' is-eligible' : ''}${spot(L, { card: card.id }) ? ' is-spotlit' : ''}${L.anim && L.anim.cardId === card.id ? ` is-${L.anim.kind}` : ''}${opts.cls ? ` ${opts.cls}` : ''}`, node);
  slot.dataset.cfCard = card.id;
  // The slot is the card box itself, so the target rectangle is exact whatever the card draws.
  const box = opts.size === 'S' ? M.CARD_S : opts.size === 'L' ? M.CARD_L : { w: ui.bands.card.w, h: ui.bands.card.h };
  slot.style.width = px(box.w);
  slot.style.height = px(box.h);
  if (eligible) slot.append(el('span', 'pl-campfire-flag', 'Eligible for the pinned page'));
  if (opts.target) drag.bindTarget(`card:${card.id}:${where}`, { kind: 'card', cardId: card.id }, slot);
  return slot;
}

/** The tutorial's spotlight (ui.tutorial.focus), when the integrator's tutorial route names a thread or a card here. */
function spot(L: Live, what: { thread: string } | { card: string }): boolean {
  const f = L.p.ui.tutorial?.focus;
  if (!f) return false;
  if ('thread' in what) return f.kind === 'thread' && f.threadId === what.thread;
  return f.kind === 'card' && f.cardId === what.card;
}

function threadsPanel(L: Live): HTMLElement {
  const v = L.p.view;
  const focused = v.focusedPair?.threadId ?? null;
  const rows = v.threads.map((t) => {
    const b = button(
      [
        el('span', 'pl-campfire-thread-kind', t.color === 'gold' ? 'Gold thread · stack to merge' : 'Red thread · stack to settle'),
        el('span', 'pl-campfire-thread-reason', t.reason),
        el('span', 'pl-campfire-thread-members', ...t.members.map((id) => el('span', '', summaryOf(L, id)))),
      ],
      `pl-campfire-thread is-${t.color}${spot(L, { thread: t.id }) ? ' is-spotlit' : ''}`,
      () => L.p.api.campfire.focus({ a: t.members[0]!, b: t.members[1]!, threadId: t.id }),
      { pressed: t.id === focused, fk: `thread:${t.id}` },
    );
    return b;
  });
  const list = el('div', 'pl-campfire-thread-list', ...(rows.length ? rows : [el('p', 'pl-campfire-muted', 'No threads at this fire: nothing to merge or settle.')]));
  list.dataset.sk = 'y:threads';
  const tut = L.p.ui.tutorial;
  return el('section', 'pl-campfire-panel pl-campfire-threads', tut ? el('p', 'pl-campfire-coach is-tutorial', tut.text) : null, L.p.view.coach ? el('p', 'pl-campfire-coach', L.p.view.coach) : null, el('h2', 'pl-campfire-h', 'Threads'), list);
}

function centre(L: Live): HTMLElement {
  const hover = M.hoverLine(L.p.ui.drag);
  let body: HTMLElement = L.proposal ? proposalVisual(L, L.proposal) : pairVisual(L);
  if (L.proposal && L.geo.mode === 'desktop') {
    // A preview card rises beside the stack (§7): what the seal leaves, the weight per file, the cases.
    const card = el('div', 'pl-campfire-panel pl-campfire-resultcard', resultHost(L));
    card.dataset.sk = 'y:result';
    body = el('div', 'pl-campfire-proposalrow', body, card);
  }
  return el('section', 'pl-campfire-centre', hover ? el('p', `pl-campfire-hover${L.p.ui.drag?.preview?.refused ? ' is-refused' : ''}`, hover) : null, body);
}

function threadLine(color: 'gold' | 'red' | null): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', `pl-campfire-thread-svg${color ? ` is-${color}` : ''}`);
  svg.setAttribute('viewBox', '0 0 48 120');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M0 60 C 14 40, 34 80, 48 60');
  svg.append(path);
  return svg;
}

function pairVisual(L: Live): HTMLElement {
  const v = L.p.view;
  const fp = v.focusedPair;
  const size = L.geo.pairCard.size;
  if (!fp) {
    return el('div', 'pl-campfire-pair is-empty', el('p', 'pl-campfire-hint', 'No threads at this fire. Drag a card into the fire to see what a cut frees, or onto the other book to write it to both files.'));
  }
  const t: ThreadView | null = fp.threadId ? (v.threads.find((x) => x.id === fp.threadId) ?? null) : null;
  const a = L.cards.get(fp.a);
  const b = L.cards.get(fp.b);
  const others = t ? t.members.filter((m) => m !== fp.a && m !== fp.b) : [];
  // On tablets the stage is too short for a caption over M cards; the threads panel beside the pair prints the reason.
  const roomy = L.geo.mode !== 'tablet';
  return el(
    'div',
    'pl-campfire-pair',
    !roomy ? null : t ? el('p', `pl-campfire-reason is-${t.color}`, el('b', '', t.color === 'gold' ? 'Gold thread' : 'Red thread'), ` · ${t.reason}`) : el('p', 'pl-campfire-reason', 'No thread joins these two.'),
    el('div', 'pl-campfire-pair-row', a ? cardSlot(L, a, 'pair', { size, source: true, target: true }) : null, threadLine(t?.color ?? null), b ? cardSlot(L, b, 'pair', { size, source: true, target: true }) : null),
    others.length && roomy ? el('p', 'pl-campfire-also', 'Also on this thread: ', ...others.map((id) => el('span', 'pl-campfire-also-card', summaryOf(L, id)))) : null,
    t && roomy ? el('p', 'pl-campfire-hint', t.color === 'gold' ? 'Drag one card onto the other to see the merge. Nothing changes until you seal.' : 'Drag one card onto the other to choose how to settle them. Cancel leaves the thread.') : null,
  );
}

function stackVisual(L: Live, order: string[], top: string, caption: Kid[], cls: string): HTMLElement {
  const size = L.geo.pairCard.size;
  const ch = L.geo.pairCard.h;
  // Headroom for the cards' Inspect control above the face (it hangs 34 px over the top edge).
  const room = L.geo.mode === 'phone' ? ch + 60 : L.geo.stage.h - L.geo.stage.bottom - 18 - M.INSPECT_HEADROOM - (L.geo.mode === 'tablet' ? 0 : 96);
  const off = M.stackOffset(order.length, room, ch);
  const box = el('div', `pl-campfire-stack ${cls}${L.snap ? ' is-snapping' : ''}`);
  box.style.width = px(L.geo.pairCard.w + off * (order.length - 1));
  box.style.height = px(ch + off * (order.length - 1));
  order.forEach((id, i) => {
    const c = L.cards.get(id);
    if (!c) return;
    // Only the top card is a drag source: pulling it off and letting go anywhere else cancels (the mount's drop on nothing).
    const s = cardSlot(L, c, `stack${i}`, { size, source: id === top, target: false, cls: id === top ? 'is-top' : '' });
    s.style.setProperty('--pl-campfire-dx', px(i * off));
    s.style.setProperty('--pl-campfire-dy', px(i * off));
    box.append(s);
  });
  const roomy = L.geo.mode !== 'tablet';
  const wrap = el('div', 'pl-campfire-stackwrap', roomy ? el('p', 'pl-campfire-reason', ...caption) : null, box, roomy ? button('Pull apart', 'pl-campfire-cancel', cancelProposal, { fk: 'pull-apart' }) : null);
  wrap.style.maxWidth = px(Math.max(L.geo.pairCard.w + off * (order.length - 1), 200) + 40);
  return wrap;
}

function proposalVisual(L: Live, p: M.Proposal): HTMLElement {
  const size = L.geo.pairCard.size;
  const one = (id: string, caption: Kid, cls: string) => {
    const c = L.cards.get(id);
    const roomy = L.geo.mode !== 'tablet';
    const w = el('div', 'pl-campfire-stackwrap', roomy ? el('p', 'pl-campfire-reason', caption) : null, c ? el('div', `pl-campfire-single ${cls}${L.snap ? ' is-snapping' : ''}`, cardSlot(L, c, 'single', { size, source: true, target: false })) : null, roomy ? button('Pull back', 'pl-campfire-cancel', cancelProposal, { fk: 'pull-apart' }) : null);
    w.style.maxWidth = px(L.geo.pairCard.w + 60);
    return w;
  };
  switch (p.kind) {
    case 'fuse':
    case 'settle':
      return stackVisual(L, M.stackOrder(p.members, p.top, p.under), p.top, [el('b', '', p.thread.color === 'gold' ? 'Gold thread' : 'Red thread'), ` · ${p.thread.reason}`], `is-${p.thread.color}`);
    case 'gone':
      return stackVisual(L, M.stackOrder(p.members, p.top, p.under), p.top, ['These cards no longer share a thread.'], 'is-gone');
    case 'swap':
      return stackVisual(L, [p.deckId, p.shelfId], p.shelfId, ['From the shelf, onto a deck card'], 'is-swap');
    case 'cut':
      return one(p.cardId, 'Over the fire', 'is-over-fire');
    case 'retarget': {
      const c = L.cards.get(p.cardId);
      return one(p.cardId, c ? `${M.filesOf(c.targets)} → ${M.filesOf(p.targets)}` : M.filesOf(p.targets), 'is-retarget');
    }
    case 'sharpen':
      return one(p.cardId, 'Sharpening the wording', 'is-sharpen');
  }
}

function side(L: Live): HTMLElement {
  const v = L.p.view;
  let body: HTMLElement;
  if (L.proposal) body = proposalPanel(L, L.proposal);
  else if (local.after && L.cards.has(local.after.resultId)) body = afterPanel(L, local.after);
  else {
    const sel = L.p.ui.selected ? L.cards.get(L.p.ui.selected) : undefined;
    body = sel && !v.ash.some((c) => c.id === sel.id) ? selectedPanel(L, sel) : tabsPanel(L);
  }
  const s = el('section', 'pl-campfire-panel pl-campfire-side', body);
  s.dataset.sk = 'y:side';
  return s;
}

// ------------------------------------------------------------------ the proposal panel

function proposalPanel(L: Live, p: M.Proposal): HTMLElement {
  const { title } = M.proposalTitle(p);
  const head: Kid[] = [];
  const controls: Kid[] = [];
  if (p.kind === 'settle') {
    const s = settleSlots(L, p);
    head.push(s.slots);
    controls.push(s.detail);
  }
  if (p.kind === 'fuse') controls.push(...fuseControls(L, p));
  if (p.kind === 'sharpen') {
    controls.push(
      editor(L, p.text, 'Write the line as it should land in the file.', (t) => {
        if (drafts.edit?.kind === 'sharpen') drafts.edit = { ...drafts.edit, text: t };
      }),
    );
  }
  if (p.kind === 'retarget' && p.from === 'chips') controls.push(el('p', 'pl-campfire-muted', 'Narrowing removes the line from one file.'));
  if (p.kind === 'cut') controls.push(el('p', 'pl-campfire-muted', 'A burned card waits in the ash until Apply, and you can restore it. Cutting a Skill pointer never deletes a skill folder.'));
  // The result (exported lines or the new text, weight, cases) sits right under the choice, or beside the stack on
  // desktop; the lines as they stand and the cases to accept follow the controls.
  const detail = el('div', 'pl-campfire-detailhost', previewPart(L, 'detail'));
  L.detailHost = detail;
  const kids: Kid[] = [el('h2', 'pl-campfire-h', title), ...head, L.geo.mode === 'desktop' ? null : resultHost(L), ...controls, detail];
  if (L.geo.mode !== 'phone') {
    const bar = el('div', 'pl-campfire-sealbar', ...sealBarKids(L));
    L.sealHosts.push(bar);
    kids.push(bar);
  }
  return el('div', 'pl-campfire-proposal', ...kids);
}

function fuseControls(L: Live, p: Extract<M.Proposal, { kind: 'fuse' }>): Kid[] {
  const t = p.thread;
  if (!p.editing) {
    return [
      el('p', 'pl-campfire-muted', 'The engine picked the shortest line that keeps every protected word.'),
      button('Edit the wording', '', () => {
        drafts.fuse[t.id] = { editing: true, text: t.autoText ?? '' };
        rerender();
      }, { fk: 'edit-wording' }),
    ];
  }
  return [
    el('p', 'pl-campfire-muted', t.autoText ? 'Your wording replaces the automatic text.' : 'No automatic text: the lines differ. The editor holds every line; write them as one.'),
    editor(L, p.text, 'Write one line that keeps what each says.', (text) => {
      drafts.fuse[t.id] = { editing: true, text };
    }),
    t.autoText
      ? button('Use the automatic text', '', () => {
          delete drafts.fuse[t.id];
          rerender();
        }, { fk: 'auto-text' })
      : null,
  ];
}

function editor(L: Live, value: string, label: string, onText: (t: string) => void): HTMLElement {
  const ta = el('textarea', 'pl-campfire-editor');
  ta.value = value;
  ta.rows = 3;
  ta.spellcheck = false;
  ta.dataset.fk = 'editor';
  ta.setAttribute('aria-label', label);
  ta.addEventListener('input', () => {
    onText(ta.value);
    refresh();
  });
  return el('label', 'pl-campfire-field', el('span', 'pl-campfire-label', label), ta, el('span', 'pl-campfire-muted', 'Enter seals · Escape cancels'));
}

function settleSlots(L: Live, p: Extract<M.Proposal, { kind: 'settle' }>): { slots: HTMLElement; detail: Kid } {
  const v = L.p.view;
  const t = p.thread;
  const d = (drafts.settle[t.id] ??= M.defaultSettle(t, v.projects));
  const set = (patch: Partial<M.SettleDraft>, full = true) => {
    drafts.settle[t.id] = { ...(drafts.settle[t.id] ?? d), ...patch };
    if (full) rerender();
    else refresh();
  };
  const slot = (s: M.SettleSlot, label: string, disabled = false) => button(label, 'pl-campfire-slotbtn', () => set({ slot: s }), { pressed: d.slot === s, fk: `slot:${s}`, disabled });
  const slots = el(
    'div',
    'pl-campfire-slots',
    slot('keep', 'Keep one'),
    slot('separate', 'Separate the conditions', v.projects.length === 0),
    slot('exception', 'Write an exception'),
    button('Cancel', 'pl-campfire-slotbtn', () => {
      delete drafts.settle[t.id];
      cancelProposal();
    }, { fk: 'slot:cancel' }),
  );
  const pick = (ids: string[], current: string, onPick: (id: string) => void, prefix: string, verb: string) =>
    el('div', 'pl-campfire-choices', ...ids.map((id) => button([`${verb}: `, el('span', 'pl-campfire-quoted', summaryOf(L, id))], 'pl-campfire-choice', () => onPick(id), { pressed: current === id, fk: `${prefix}:${id}` })));
  let detail: Kid = null;
  if (d.slot === 'keep') detail = el('div', 'pl-campfire-detail', el('span', 'pl-campfire-label', 'Keep which line? The other is cut.'), pick(t.members, d.keep, (id) => set({ keep: id }), 'keep', 'Keep'));
  if (d.slot === 'separate') {
    detail = el(
      'div',
      'pl-campfire-detail',
      el('span', 'pl-campfire-label', 'Which line applies only in one project? The other gains an exception for it.'),
      pick(t.members, d.bind, (id) => set({ bind: id }), 'bind', 'Only in a project'),
      el('span', 'pl-campfire-label', 'Which project?'),
      el('div', 'pl-campfire-choices', ...v.projects.map((pr) => button(pr.label, 'pl-campfire-choice', () => set({ projectKey: pr.key }), { pressed: d.projectKey === pr.key, fk: `project:${pr.key}` }))),
    );
  }
  if (d.slot === 'exception') {
    const text = el('input', 'pl-campfire-input');
    text.type = 'text';
    text.value = d.text;
    text.placeholder = 'unless the user names a test file';
    text.dataset.fk = 'exception-text';
    text.setAttribute('aria-label', 'The exception, in words');
    text.addEventListener('input', () => set({ text: text.value }, false));
    const whenBtn = (w: M.WhenKind, label: string, disabled = false) => button(label, 'pl-campfire-choice', () => set({ when: w, whenValue: w === 'project' ? (v.projects[0]?.key ?? '') : '' }), { pressed: d.when === w, fk: `when:${w}`, disabled });
    let value: Kid = null;
    if (d.when === 'project') value = el('div', 'pl-campfire-choices', ...v.projects.map((pr) => button(pr.label, 'pl-campfire-choice', () => set({ whenValue: pr.key }), { pressed: d.whenValue === pr.key, fk: `when-project:${pr.key}` })));
    if (d.when === 'command' || d.when === 'path') {
      const inp = el('input', 'pl-campfire-input pl-campfire-mono');
      inp.type = 'text';
      inp.value = d.whenValue;
      inp.placeholder = d.when === 'command' ? 'pytest tests/' : 'src/legacy/';
      inp.dataset.fk = `when-value:${d.when}`;
      inp.setAttribute('aria-label', d.when === 'command' ? 'The command starts with' : 'The path starts with');
      inp.addEventListener('input', () => set({ whenValue: inp.value }, false));
      value = inp;
    }
    detail = el(
      'div',
      'pl-campfire-detail',
      el('span', 'pl-campfire-label', 'On which line?'),
      pick(t.members, d.on, (id) => set({ on: id }), 'on', 'On'),
      el('label', 'pl-campfire-field', el('span', 'pl-campfire-label', 'The exception, as it will read'), text),
      el('span', 'pl-campfire-label', 'When does it apply?'),
      el('div', 'pl-campfire-choices', whenBtn('always', 'As written'), whenBtn('project', 'In a project', v.projects.length === 0), whenBtn('command', 'Command starts with'), whenBtn('path', 'Path starts with')),
      value,
    );
  }
  return { slots, detail };
}

function resultHost(L: Live): HTMLElement {
  const host = el('div', 'pl-campfire-resulthost', previewPart(L, 'result'));
  L.resultHost = host;
  return host;
}

/** The preview with the campfire's words: card titles, case tags, a Read control per case. */
function previewPart(L: Live, part: 'result' | 'detail'): HTMLElement {
  const v = L.p.view;
  const ctx: PreviewCtx = {
    title: (id) => (L.cards.has(id) ? cardTitle(L, id) : null),
    caseLabel: (id) => M.caseTag(id, v),
    onCase: (id) => L.p.api.inspect({ caseId: id }),
    empty:
      L.proposal?.kind === 'settle' ? 'Pick a slot: the lines as they would be exported show here before you seal. Cancel leaves the red thread.' : 'The preview shows here: the lines as they would be exported, the weight per file and the cases.',
  };
  return part === 'result' ? resultPart(L.preview, ctx) : detailPart(L.preview, ctx);
}

interface PreviewCtx {
  title(cardId: string): string | null;
  caseLabel(caseId: string): string | null;
  onCase: ((caseId: string) => void) | null;
  empty: string;
}

const sect = (h: string, ...kids: Kid[]) => el('section', 'pl-campfire-sect', el('h3', 'pl-campfire-sect-h', h), ...kids);
const lineRow = (text: string | null, title: string | null, struck: boolean, files: string[] = []) =>
  el(
    'li',
    `pl-campfire-linerow${struck ? ' is-struck' : ''}`,
    title ? el('span', 'pl-campfire-line-title', title) : null,
    el('span', 'pl-campfire-mono', text === null ? 'removed from the files' : inline(text, true)),
    files.length ? el('span', 'pl-campfire-chips', ...files.map((f) => el('span', 'pl-campfire-chip', f))) : null,
  );

/** What the seal would leave: a refusal, the deleted line, the new text with its chips, or a settlement's exported lines. */
function resultPart(pv: ChangePreviewView | null, ctx: PreviewCtx): HTMLElement {
  const root = el('div', 'pl-campfire-seal pl-campfire-result');
  if (!pv) {
    root.append(el('p', 'pl-campfire-muted', ctx.empty));
    return root;
  }
  if (pv.refused) root.append(el('p', 'pl-campfire-refused', pv.refused));
  const cut = pv.after === null && pv.lines.length === 0;
  if (cut) root.append(sect('Deleted from the files', el('ul', 'pl-campfire-lines', ...pv.before.map((b) => lineRow(b.text, ctx.title(b.id), true)))));
  if (pv.after) {
    const a = pv.after;
    root.append(
      sect(
        'After the seal',
        el('p', 'pl-campfire-reading', inline(a.text, true)),
        el(
          'div',
          'pl-campfire-chips',
          el('span', 'pl-campfire-chip', M.filesOf(a.targets)),
          el('span', 'pl-campfire-chip', a.scope),
          a.trigger ? el('span', 'pl-campfire-chip', `when ${a.trigger}`) : null,
          ...a.exceptions.map((x) => el('span', 'pl-campfire-chip is-kept', `kept: ${x}`)),
        ),
      ),
    );
  }
  if (pv.lines.length) root.append(sect('Exported after the seal', el('ul', 'pl-campfire-lines', ...pv.lines.map((l) => lineRow(l.text, ctx.title(l.id), l.text === null, l.files)))));
  root.append(
    sect(
      'Weight',
      el('table', 'pl-campfire-weights', el('tbody', '', ...M.weightRows(pv.ghost).map((r) => el('tr', '', el('th', '', r.file), el('td', 'pl-campfire-mono', r.span), el('td', 'pl-campfire-delta', el('span', 'pl-campfire-mono', r.delta), ' ', el('span', 'pl-campfire-est', r.estimated)))))),
    ),
    sect(
      'Cases',
      el('p', 'pl-campfire-cases', pv.cases.text),
      pv.cases.opened.length ? el('div', '', el('span', 'pl-campfire-label', 'Reopens'), el('ul', 'pl-campfire-caselist', ...pv.cases.opened.map((id) => caseRow(id, ctx)))) : null,
      pv.cases.addressed.length ? el('div', '', el('span', 'pl-campfire-label', 'Newly addressed'), el('ul', 'pl-campfire-caselist', ...pv.cases.addressed.map((id) => caseRow(id, ctx)))) : null,
    ),
  );
  return root;
}

function caseRow(id: string, ctx: PreviewCtx): HTMLElement {
  return el('li', 'pl-campfire-case', el('span', '', ctx.caseLabel(id) ?? 'A reviewed case'), ctx.onCase ? button('Read', 'pl-campfire-small', () => ctx.onCase!(id), { fk: `read:${id}` }) : null);
}

/** The lines as they stand, the weight per file (estimated), the cases, and the cases a new text must be accepted for. */
function detailPart(pv: ChangePreviewView | null, ctx: PreviewCtx): HTMLElement {
  const root = el('div', 'pl-campfire-seal pl-campfire-detail-part');
  if (!pv) return root;
  const caseChip = (id: string) => caseRow(id, ctx);
  const cut = pv.after === null && pv.lines.length === 0;
  if (!cut) root.append(sect('Now', el('ul', 'pl-campfire-lines', ...pv.before.map((b) => lineRow(b.text, ctx.title(b.id), false)))));
  if (pv.needsAcceptance.length) {
    root.append(sect('Accept the new text', el('p', 'pl-campfire-muted', 'A new text binds nothing until you accept it for each case. After the seal, accept it here:'), el('ul', 'pl-campfire-caselist', ...pv.needsAcceptance.map(caseChip))));
  }
  return root;
}

function sealBarKids(L: Live): Kid[] {
  const p = L.proposal;
  if (!p) return [];
  const { seal } = M.proposalTitle(p);
  const ok = !!L.seal.call;
  const b = el('button', `pl-campfire-sealbtn${L.p.ui.reducedMotion ? ' is-static' : ''}`, el('span', 'pl-campfire-wax', ''), el('span', 'pl-campfire-seal-label', seal), el('small', 'pl-campfire-seal-sub', 'hold, or press Enter'), el('small', 'pl-campfire-seal-hold', 'keep holding'));
  b.type = 'button';
  b.dataset.role = 'seal';
  b.dataset.fk = 'seal';
  b.disabled = !ok;
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [h] = M.holdStep(local.hold, { type: 'down', t: e.timeStamp, sealable: !!live?.seal.call });
    local.hold = h;
    if (h.kind !== 'holding') return;
    b.classList.add('is-holding');
    holdOn = { key: snapKeyOf(live?.proposal ?? null), button: b };
    if (local.holdTimer) clearTimeout(local.holdTimer);
    local.holdTimer = setTimeout(() => {
      const [next, go] = M.holdStep(local.hold, { type: 'tick', t: performance.now() });
      local.hold = next;
      local.holdTimer = null;
      if (go) holdSeal();
    }, M.HOLD_MS);
  });
  const letGo = (t: number | null) => {
    if (holdOn?.button !== b) return;
    const [, go] = t === null ? M.holdStep(local.hold, { type: 'cancel' }) : M.holdStep(local.hold, { type: 'up', t });
    if (go) holdSeal();
    else holdReset();
  };
  b.addEventListener('pointerup', (e) => letGo(e.timeStamp));
  b.addEventListener('pointerleave', () => letGo(null));
  b.addEventListener('pointercancel', () => letGo(null));
  // A click alone never seals: the seal is a 0.6 s hold, or Enter (handled by the campfire's key listener).
  return [p.kind === 'settle' ? null : button('Cancel', 'pl-campfire-cancel', cancelProposal, { fk: 'bar-cancel' }), b, L.seal.why ? el('p', 'pl-campfire-why', L.seal.why) : null];
}

// ------------------------------------------------------------------ the other side panels

function afterPanel(L: Live, a: AfterSeal): HTMLElement {
  const api = L.p.api;
  const rows = a.cases.map((id) =>
    el(
      'li',
      'pl-campfire-case',
      el('span', '', (a.labels[id] = M.caseTag(id, L.p.view) ?? a.labels[id] ?? 'A reviewed case')),
      button('Read', 'pl-campfire-small', () => api.inspect({ caseId: id }), { fk: `after-read:${id}` }),
      a.bound.has(id)
        ? el('span', 'pl-campfire-done', 'Accepted · now addressed')
        : a.accepted.has(id)
          ? el('span', 'pl-campfire-done', 'Accepted')
          : button('Accept for this case', 'pl-campfire-small is-primary', () => {
              a.sent = id;
              api.campfire.acceptMapping(a.resultId, id);
            }, { fk: `accept:${id}` }),
    ),
  );
  return el(
    'div',
    'pl-campfire-after',
    el('h2', 'pl-campfire-h', 'Accept the new line'),
    el('p', 'pl-campfire-reading', inline(a.text, true)),
    el('p', 'pl-campfire-muted', 'The sealed text binds nothing until you accept it for a case. Read each case, then accept it where the line answers it.'),
    el('ul', 'pl-campfire-caselist', ...rows),
    button('Done', '', () => {
      local.after = null;
      rerender();
    }, { fk: 'after-done' }),
  );
}

function selectedPanel(L: Live, c: CardView): HTMLElement {
  const { api, view: v } = L.p;
  const onShelf = v.piles.shelf.some((x) => x.id === c.id);
  const actions: Kid[] = [];
  if (onShelf) {
    actions.push(el('p', 'pl-campfire-muted', 'A shelf card returns only as a swap: drag it, or tap a deck card of the same family, to see the swap.'));
  } else {
    actions.push(
      button('Sharpen the wording', '', () => {
        drafts.edit = { kind: 'sharpen', cardId: c.id, text: c.inspector.exact };
        rerender();
      }, { fk: 'act:sharpen' }),
      button('Into the fire', '', () => api.tapTarget({ kind: 'fire' }), { fk: 'act:fire' }),
    );
    if (c.targets !== 'both') {
      const other = c.targets === 'claude' ? 'codex' : 'claude';
      actions.push(button(`Also write it to ${FILE_OF[other]}`, '', () => api.tapTarget({ kind: 'book-retarget', lane: other }), { fk: 'act:widen' }));
    } else {
      for (const lane of ['claude', 'codex'] as const) {
        actions.push(button(`Keep it in ${FILE_OF[lane]} only`, '', () => {
          drafts.edit = { kind: 'narrow', cardId: c.id, targets: lane };
          rerender();
        }, { fk: `act:narrow-${lane}` }));
      }
    }
  }
  actions.push(button('Inspect', '', () => api.inspect({ cardId: c.id }), { fk: 'act:inspect' }), button('Clear selection', '', () => api.select(null), { fk: 'act:clear' }));
  return el(
    'div',
    'pl-campfire-selected',
    el('h2', 'pl-campfire-h', c.face.title),
    el('p', 'pl-campfire-reading', inline(c.inspector.exact, true)),
    el('div', 'pl-campfire-chips', el('span', 'pl-campfire-chip', M.filesOf(c.targets)), el('span', 'pl-campfire-chip', c.scope), el('span', 'pl-campfire-chip pl-campfire-mono', `${c.weight} ${COPY.estimated}`)),
    el('div', 'pl-campfire-actions', ...actions),
    onShelf ? null : el('p', 'pl-campfire-muted', 'Or drag it: onto a card on its thread, into the fire, or onto the other book. Nothing changes until you seal.'),
  );
}

function tabsPanel(L: Live): HTMLElement {
  const { view: v, api } = L.p;
  const tab = (k: typeof local.side, label: string) => button(label, 'pl-campfire-tab', () => {
    local.side = k;
    rerender();
  }, { pressed: local.side === k, fk: `side:${k}` });
  const tabs = el('div', 'pl-campfire-tabs', tab('shelf', `Shelf · ${v.piles.shelfCount}`), tab('ash', `Ash · ${v.ashCount}`), tab('open', v.pinned ? 'Pinned page' : `Open · ${v.piles.openCount}`));
  let body: HTMLElement;
  if (local.side === 'shelf') {
    if (v.piles.shelfCount === 0) body = el('p', 'pl-campfire-muted', 'The shelf is empty. Cards you skip rest there; at the fire, drag one onto a deck card of the same family to see a swap.');
    else {
      const strip = el('div', 'pl-campfire-shelf', ...v.piles.shelf.map((c) => cardSlot(L, c, 'shelf', { size: L.geo.pairCard.size, source: true, target: false })));
      strip.dataset.sk = 'x:shelf';
      body = el('div', '', el('p', 'pl-campfire-muted', 'Never written. Drag one onto a deck card of the same family to see the swap.'), strip);
    }
  } else if (local.side === 'ash') {
    if (v.ashCount === 0) body = el('p', 'pl-campfire-muted', 'Nothing burned yet. A cut card waits here until Apply, and you can restore it.');
    else {
      body = el(
        'ul',
        'pl-campfire-ash',
        ...v.ash.map((c) => el('li', 'pl-campfire-ashrow', el('span', 'pl-campfire-line-title', c.face.title), el('span', 'pl-campfire-mono is-struck', inline(c.inspector.exact, true)), button('Restore', 'pl-campfire-small', () => api.campfire.restore(c.id), { fk: `restore:${c.id}` }))),
      );
    }
  } else body = openPanel(L);
  const note = local.reopened
    ? el(
        'div',
        'pl-campfire-reopened',
        el('span', 'pl-campfire-label', 'The cut reopened'),
        el('ul', 'pl-campfire-caselist', ...local.reopened.cases.map((id) => el('li', 'pl-campfire-case', el('span', '', M.caseTag(id, v) ?? 'A reviewed case'), button('Read', 'pl-campfire-small', () => api.inspect({ caseId: id }), { fk: `reopened:${id}` })))),
        button('Dismiss', 'pl-campfire-small', () => {
          local.reopened = null;
          rerender();
        }, { fk: 'reopened-done' }),
      )
    : null;
  return el('div', 'pl-campfire-tabspanel', note, tabs, body, el('p', 'pl-campfire-muted pl-campfire-free', 'Leaving is free. Apply is where an open clasp waits.'));
}

function openPanel(L: Live): HTMLElement {
  const { view: v, api } = L.p;
  if (v.pinned) {
    const r = v.pinned.receipt;
    return el(
      'div',
      'pl-campfire-pinned',
      el('p', 'pl-campfire-tag', M.tagText(v.pinned.tag)),
      r.quote ? el('p', 'pl-campfire-quote', '“', inline(r.quote), '”') : el('p', 'pl-campfire-muted', 'Tool evidence only'),
      r.action || r.result ? el('p', 'pl-campfire-mono', inline([r.action, r.result].filter(Boolean).join(' → '))) : null,
      el('p', 'pl-campfire-muted', 'Pinned as a puzzle. Each deck card shows whether it is eligible for this case: eligibility, never coverage. It is not a drop target.'),
      el(
        'ul',
        'pl-campfire-cands',
        ...[...v.pinnedCandidates.filter((c) => c.glow), ...v.pinnedCandidates.filter((c) => !c.glow)].map((c) => el('li', `pl-campfire-cand${c.glow ? ' is-glow' : ''}`, el('span', '', summaryOf(L, c.cardId)), el('span', 'pl-campfire-cand-why', c.glow ? 'eligible · not accepted' : (c.reason ?? COPY.noEligibleCard)))),
      ),
      el('div', 'pl-campfire-actions', button('Read the case', 'pl-campfire-small', () => api.inspect({ caseId: v.pinned!.caseId }), { fk: 'pin-read' }), button('Unpin', 'pl-campfire-small', () => api.campfire.pin(null), { fk: 'unpin' })),
    );
  }
  if (v.piles.openCount === 0) return el('p', 'pl-campfire-muted', 'No Open pages: every confirmed case has a line in the proposal.');
  return el(
    'div',
    '',
    el('p', 'pl-campfire-muted', 'Pin one Open page as a puzzle: the deck shows which cards are eligible for it.'),
    el(
      'ul',
      'pl-campfire-openlist',
      ...v.piles.open.map((o) =>
        el(
          'li',
          'pl-campfire-openrow',
          el('span', 'pl-campfire-tag', M.tagText(o.tag)),
          o.receipt.quote ? el('span', 'pl-campfire-quote is-short', '“', inline(o.receipt.quote), '”') : el('span', 'pl-campfire-muted', 'Tool evidence only'),
          el('span', 'pl-campfire-actions', button('Pin', 'pl-campfire-small', () => api.campfire.pin(o.caseId), { fk: `pin:${o.caseId}` }), button('Read', 'pl-campfire-small', () => api.inspect({ caseId: o.caseId }), { fk: `open-read:${o.caseId}` })),
        ),
      ),
    ),
  );
}

function bottomRow(L: Live): HTMLElement {
  const { view: v, api } = L.p;
  const row = el('div', 'pl-campfire-bottom');
  row.style.height = px(L.p.ui.bands.touch.min);
  if (L.geo.mode === 'phone' && L.proposal) {
    const bar = el('div', 'pl-campfire-sealbar is-row', ...sealBarKids(L));
    L.sealHosts.push(bar);
    row.append(bar);
    return row;
  }
  const tabs = el('nav', 'pl-campfire-lanetabs', ...M.LANE_TABS.map((t) => button(t.label, 'pl-campfire-lanetab', () => api.campfire.tab(t.tab), { pressed: v.tab === t.tab, fk: `lane:${t.tab}` })));
  tabs.setAttribute('aria-label', 'Lanes');
  const leave = button('Leave the campfire', 'pl-campfire-leave', () => api.advance(), { fk: 'leave' });
  if (L.geo.mode !== 'phone') {
    tabs.style.left = px(L.geo.lane.x);
    leave.style.left = px(L.geo.stage.pad);
  }
  row.append(tabs, leave);
  return row;
}

// ------------------------------------------------------------------ the wood band

function fillWood(L: Live): void {
  const { view: v, ui, api, drag } = L.p;
  const geo = L.geo;
  const pending = ui.pending;
  const hot = ui.drag?.target?.kind === 'fire';
  const lit = pending?.kind === 'cut';
  const ns = 'http://www.w3.org/2000/svg';
  const ring = document.createElementNS(ns, 'svg');
  ring.setAttribute('class', 'pl-campfire-ring');
  ring.setAttribute('viewBox', '0 0 100 100');
  ring.setAttribute('preserveAspectRatio', 'none');
  ring.setAttribute('aria-hidden', 'true');
  const ell = document.createElementNS(ns, 'ellipse');
  ell.setAttribute('cx', '50');
  ell.setAttribute('cy', '50');
  ell.setAttribute('rx', '47');
  ell.setAttribute('ry', '47');
  ring.append(ell);
  const fire = el('div', `pl-campfire-fire${hot ? ' is-hot' : ''}${lit ? ' is-lit' : ''}${L.anim?.kind === 'cut' ? ' is-burning' : ''}`, ring, el('span', 'pl-campfire-fire-label', lit ? 'Over the fire' : 'The fire'), el('span', 'pl-campfire-fire-ash', `Ash · ${v.ashCount}`));
  fire.setAttribute('aria-label', 'The fire: drop a card here to see a cut');
  fire.style.width = px(geo.fire.w);
  fire.style.height = px(geo.fire.h);
  fire.style.marginTop = px(geo.fire.y);
  drag.bindTarget('fire', { kind: 'fire' }, fire);
  const lane = el('div', 'pl-campfire-lane', ...v.lanes[v.tab].map((c) => cardSlot(L, c, 'lane', { size: ui.bands.card.size, source: true, target: true })));
  lane.dataset.sk = `x:lane:${v.tab}`;
  lane.setAttribute('aria-label', `${M.LANE_TABS.find((t) => t.tab === v.tab)!.label} lane`);
  if (v.lanes[v.tab].length === 0) lane.append(el('p', 'pl-campfire-empty', v.tab === 'both' ? 'No card is in both files yet. Drag a card onto the other book to see it in both.' : 'No cards in this lane.'));
  refreshBooks(L);
  const piles = el('div', 'pl-campfire-piles', Piles({ piles: v.piles, layout: ui.bands.piles.mode, shelfTarget: false, api, drag }));
  if (geo.mode === 'phone') {
    lane.style.height = px(ui.bands.card.h + M.INSPECT_HEADROOM);
    lane.style.paddingTop = px(M.INSPECT_HEADROOM);
    L.wood.style.padding = `0 ${px(geo.wood.pad)}`;
    L.wood.style.rowGap = px(8);
    L.wood.style.columnGap = px(geo.wood.gap);
    L.wood.style.gridTemplateColumns = `${px(geo.wood.piles)} minmax(0, 1fr)`;
    L.wood.style.gridTemplateRows = `${px(ui.bands.card.h + M.INSPECT_HEADROOM)} ${px(ui.bands.touch.min)} ${px(ui.bands.touch.min)}`;
    fire.style.marginTop = '0';
    L.wood.replaceChildren(lane, L.booksHost, piles, fire);
  } else {
    // The lane fills the band; the cards sit low enough for their Inspect control to show above them.
    lane.style.height = px(geo.wood.h);
    lane.style.paddingTop = px(Math.max(0, Math.min(M.INSPECT_HEADROOM, geo.wood.h - ui.bands.card.h - 4)));
    L.wood.style.padding = `0 ${px(geo.wood.pad)}`;
    L.wood.style.columnGap = px(geo.wood.gap);
    L.wood.style.gridTemplateColumns = `${px(geo.wood.books)} ${px(geo.fire.w)} minmax(0, 1fr) ${px(geo.wood.piles)}`;
    L.wood.replaceChildren(L.booksHost, fire, lane, piles);
  }
}
