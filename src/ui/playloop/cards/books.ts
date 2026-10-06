// Owner: cards/layout. CLAUDE.md and AGENTS.md as books on the wood (play-loop §1, §5, §0a.1, §0a.5, §0a.9): the
// Proposed watermark, the leather strap meter with its clasp, the per-lane ghost while dragging, and the exact line
// typeset on the open page at reading size before release. Drop targets: play (rooms) or re-target (campfire).
// Import from ../contract only. Never the adapter or the engine.
import type { BookView, CardView, DragPreview, DropBinder, GhostDelta } from '../contract';
import { COPY } from '../contract';
import { el, fig, inline, svg } from './dom';
import './cards.css';

export interface BooksProps {
  books: BookView[];
  /** The live drag preview: the strap ghost per lane and the exact line typeset on the open page. */
  preview: DragPreview | null;
  /** Room: a drop plays into that file. Campfire: a drop re-targets a card already in the proposal. */
  mode: 'play' | 'retarget';
  /** Props on the wood, or two 44 px tabs on phones (bands.books.mode). */
  layout: 'props' | 'tabs';
  drag: DropBinder;
  /**
   * Optional (not in the frozen props; see the contract asks): the proposal's cards (RoomView.deck, BossView.cards).
   * When given, each book lists its lines as draggable slips, so a card in a book can be dragged onto a head.
   */
  cards?: CardView[];
  /** Optional: card ids that glow (boss candidates); only these slips are marked. */
  glow?: readonly string[];
  /** Optional: open a slip's card in the inspector. */
  onInspect?(cardId: string): void;
}

/** The strap in percent of its length: the fill, the allowance notch, and the ghost segment of a drag. */
export function strapGeom(w: BookView['weight'], ghost: Pick<GhostDelta, 'before' | 'after'> | null): { fill: number; notch: number; ghost: { from: number; to: number; grows: boolean } | null } {
  const top = Math.max(w.allowance, w.now, ghost?.after ?? 0, ghost?.before ?? 0, 1);
  const pct = (n: number) => Math.round((Math.max(0, n) / top) * 1000) / 10;
  const g = ghost && ghost.after !== ghost.before ? { from: pct(Math.min(ghost.before, ghost.after)), to: pct(Math.max(ghost.before, ghost.after)), grows: ghost.after > ghost.before } : null;
  return { fill: pct(w.now), notch: pct(w.allowance), ghost: g };
}

const last = new Map<string, number>();
const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** CLAUDE.md and AGENTS.md as books with leather strap meters and the Proposed watermark (§1, §5, §0a.1). */
export function Books(p: BooksProps): HTMLElement {
  const root = el('div', `pl-cards-books pl-cards-books-${p.layout} pl-cards-books-${p.mode}`);
  const line = p.preview?.line ?? null;
  for (const b of p.books) {
    const ghost = p.preview ? p.preview.ghost[b.lane] : null;
    const dest = !!line && line.files.includes(b.file);
    const node = p.layout === 'tabs' ? Tab(b, ghost, dest) : Book(b, ghost, dest, p);
    p.drag.bindTarget(`book:${b.lane}:${p.mode}`, p.mode === 'play' ? { kind: 'book', lane: b.lane } : { kind: 'book-retarget', lane: b.lane }, node);
    root.append(node);
  }
  // The open page: the exact line at reading size, its scope, exceptions and destination files, before release (§0a.5).
  if (p.preview && (line || p.preview.refused)) root.append(Page(p.preview, p));
  return root;
}

function Strap(b: BookView, ghost: GhostDelta | null): HTMLElement {
  const g = strapGeom(b.weight, ghost);
  const fill = el('i', 'pl-cards-strap-fill');
  fill.style.width = `${g.fill}%`;
  const notch = el('i', 'pl-cards-strap-notch');
  notch.style.left = `${g.notch}%`;
  const track = el('div', `pl-cards-strap${b.weight.over ? ' is-over' : ''}${b.weight.noGrowth ? ' is-tight' : ''}`, fill, notch);
  if (g.ghost) {
    const seg = el('i', `pl-cards-strap-ghost${g.ghost.grows ? '' : ' is-drain'}`);
    seg.style.left = `${g.ghost.from}%`;
    seg.style.width = `${Math.max(0.6, g.ghost.to - g.ghost.from)}%`;
    track.append(seg);
  }
  // The strap pours to the real value when it changed since the last paint (a committed act); never under reduced motion.
  const prev = last.get(b.lane);
  last.set(b.lane, b.weight.now);
  if (prev !== undefined && prev !== b.weight.now && !still() && typeof fill.animate === 'function') {
    const from = strapGeom({ ...b.weight, now: prev }, null).fill;
    fill.animate([{ width: `${from}%` }, { width: `${g.fill}%` }], { duration: 420, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  }
  const clasp = svg('0 0 16 16', `pl-cards-clasp${b.weight.over ? ' is-open' : ''}`, b.weight.over ? [{ d: 'M3 4h7v8H3Z' }, { d: 'M10 8h4.5' }] : [{ d: 'M3 4h7v8H3Z' }, { d: 'M6.5 8H13' }], b.weight.over ? 'Clasp open: over the allowance' : 'Clasp shut: within the allowance');
  return el('div', 'pl-cards-strapwrap', track, clasp);
}

/** The file path, breakable only after a slash. */
function Path(path: string): HTMLElement {
  const e = el('span', 'pl-cards-book-path');
  path.split('/').forEach((part, i, all) => {
    e.append(part + (i < all.length - 1 ? '/' : ''));
    if (i < all.length - 1) e.append(document.createElement('wbr'));
  });
  return e;
}

function Figures(b: BookView): HTMLElement {
  return el('p', 'pl-cards-book-fig', el('span', 'pl-cards-mono', `${fig(b.weight.now)} / ${fig(b.weight.allowance)}`), ` ${COPY.estimated}`);
}

function Notes(b: BookView): (HTMLElement | null)[] {
  return [
    b.weight.noGrowth ? el('p', 'pl-cards-book-note', 'No growth: this file arrived over the line.') : null,
    b.weight.raisedBy !== null ? el('p', 'pl-cards-book-note', 'Allowance raised by you.') : null,
    b.blocked ? el('p', 'pl-cards-book-note is-blocked', b.blocked) : null,
    !b.loaded ? el('p', 'pl-cards-book-note', 'File not read.') : null,
  ];
}

function Book(b: BookView, ghost: GhostDelta | null, dest: boolean, p: BooksProps): HTMLElement {
  const book = el(
    'div',
    `pl-cards-book${dest ? ' is-dest' : ''}${b.weight.over ? ' is-over' : ''}`,
    el('div', 'pl-cards-book-head', el('b', 'pl-cards-book-name', b.file), Path(b.path)),
    Strap(b, ghost),
    Figures(b),
    ghost && p.preview ? el('p', 'pl-cards-book-ghost', el('span', 'pl-cards-mono', ghost.text), ` ${COPY.estimated}`) : null,
    ...Notes(b),
  );
  book.dataset.lane = b.lane;
  book.setAttribute('aria-label', `${b.file}: ${b.weight.now} of ${b.weight.allowance} ${COPY.estimated}${b.proposed ? `, ${COPY.proposed}` : ''}`);
  if (b.proposed) {
    const w = el('span', 'pl-cards-proposed', COPY.proposed);
    w.setAttribute('aria-hidden', 'true');
    book.append(w);
  }
  if (p.cards) {
    const byId = new Map(p.cards.map((c) => [c.id, c]));
    const slips = el('ol', 'pl-cards-slips');
    for (const id of b.cardIds) {
      const c = byId.get(id);
      if (!c) continue;
      const slip = el('li', `pl-cards-slip${p.glow?.includes(id) ? ' is-glow' : ''}`, el('span', 'pl-cards-slip-text', ...inline(c.face.summary)), el('span', 'pl-cards-mono pl-cards-slip-w', `+${c.weight}`));
      slip.dataset.card = id;
      slip.title = c.inspector.exact;
      p.drag.bindCard(id, slip);
      if (p.onInspect) slip.addEventListener('contextmenu', (e) => (e.preventDefault(), p.onInspect!(id)));
      slips.append(slip);
    }
    book.append(slips);
  }
  return book;
}

/** The whole-file delta of a ghost, signed ("+68", "−15", "no change"); the per-part split prints on the page. */
export function signedDelta(g: Pick<GhostDelta, 'delta'>): string {
  return g.delta > 0 ? `+${fig(g.delta)}` : g.delta < 0 ? fig(g.delta) : 'no change';
}

function Tab(b: BookView, ghost: GhostDelta | null, dest: boolean): HTMLElement {
  const tab = el(
    'div',
    `pl-cards-booktab${dest ? ' is-dest' : ''}${b.weight.over ? ' is-over' : ''}`,
    el('div', 'pl-cards-booktab-row', el('b', 'pl-cards-book-name', b.file), Strap(b, ghost)),
    ghost ? el('p', 'pl-cards-book-fig', el('span', 'pl-cards-mono', signedDelta(ghost)), ghost.delta !== 0 ? ` ${COPY.estimated}` : '') : Figures(b),
    b.proposed ? el('span', 'pl-cards-proposed-tag', COPY.proposed) : null,
  );
  tab.dataset.lane = b.lane;
  tab.setAttribute('aria-label', `${b.file}: ${b.weight.now} of ${b.weight.allowance} ${COPY.estimated}`);
  if (b.blocked) tab.title = b.blocked;
  return tab;
}

function Page(pv: DragPreview, p: BooksProps): HTMLElement {
  const l = pv.line;
  const page = el(
    'div',
    `pl-cards-page${pv.refused ? ' is-refused' : ''}`,
    l ? el('p', 'pl-cards-page-files', 'Lands in ', ...l.files.flatMap((f, i) => [i ? ' · ' : '', el('b', '', f)])) : null,
    l ? el('p', 'pl-cards-page-line', ...inline(l.text)) : null,
    l ? el('p', 'pl-cards-page-meta', `Scope: ${l.scope}`, l.exceptions[0] !== undefined ? ` · Except: ${l.exceptions.join('; ')}` : ' · No exceptions') : null,
    pv.accepts[0] !== undefined ? el('p', 'pl-cards-page-meta', 'Releasing here accepts this reading for the heads that glow.') : null,
    p.layout === 'tabs' ? el('p', 'pl-cards-page-meta', ...p.books.flatMap((b, i) => [i ? ' · ' : '', el('b', '', b.file), ` ${pv.ghost[b.lane].text} ${COPY.estimated}`])) : null,
    pv.refused ? el('p', 'pl-cards-refused', pv.refused) : null,
  );
  page.setAttribute('role', 'status');
  return page;
}

