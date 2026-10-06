// Owner: cards/layout. The one card box (play-loop §10, §0a.18, §0a.20). Every card in the game renders through Card:
// the hand, the books, the piles, the campfire's lanes and the boss's answer cards.
// Import from ../contract only. Never the adapter or the engine.
import type { CardView, DropBinder } from '../contract';
import { BLOCK_HEADER_WHY, COPY } from '../contract';
import { ART_FOCUS, asset, button, cardArt, el, ImportedEmblem, inline, Sigil, svg, TypeGlyph } from './dom';
import './cards.css';

export interface CardProps {
  card: CardView;
  /** M is the default and the minimum reading size at every width ≥ 600 (§0a.18). */
  size: 'S' | 'M' | 'L';
  selected: boolean;
  /** Draggable when a binder is given (hand, deck at the fire, shelf at the fire). */
  drag: DropBinder | null;
  /** Long-press, right-click, F or the external 44 px Inspect control. */
  onInspect(cardId: string): void;
  /**
   * Optional: Enter or Space on the focused card (the card is a focusable button). The hand selects it; the campfire
   * selects it, or stacks the selected card on it. Without it, Enter and Space fall through to the table's keys.
   */
  onActivate?(cardId: string): void;
}

/** Card boxes in px (§10): one box per size, 5:7. The zones never move. */
export const CARD_BOX = { S: { w: 148, h: 207 }, M: { w: 176, h: 246 }, L: { w: 208, h: 291 } } as const;

const LONG_PRESS_MS = 450;
const MOVE_PX = 6;

/** The face text a card shows: the view's face, or (when it does not fit at this size) a marked excerpt of the exact line. */
export function faceText(card: Pick<CardView, 'face'> & { inspector: { exact: string } }, overflowed: boolean): { text: string; mark: string | null; fallback: boolean } {
  const f = card.face;
  if (f.mode === 'excerpt') return { text: f.summary, mark: f.mark, fallback: false };
  if (!overflowed) return { text: f.summary, mark: null, fallback: false };
  // §0a.5 and the contract: never clamp a summary silently, never shrink the reading size. Show the exact line,
  // clamped, and say so.
  return { text: card.inspector.exact, mark: COPY.excerpt, fallback: true };
}

/** Split the room footer ("n eligible here · m newly addressed") at its separator so it can stack at M. */
export function footerParts(text: string): string[] {
  return text.split(' · ').filter((s) => s.length > 0);
}

const views = new WeakMap<HTMLElement, CardView>();
let queued = false;
let fontsHooked = false;

/** The one card box (§10): top band, art window, title, summary, footer. No verbs, no buttons on the face. */
export function Card(p: CardProps): HTMLElement {
  const c = p.card;
  const root = el('div', `pl-cards-card pl-cards-${p.size}${p.selected ? ' is-selected' : ''}`);
  root.dataset.card = c.id;
  root.dataset.type = c.type;
  root.dataset.size = p.size;
  // The card is a focusable button: a click selects it (the drag core's tap), Enter or Space too (onActivate).
  root.setAttribute('role', 'button');
  root.tabIndex = 0;
  root.setAttribute('aria-pressed', String(p.selected));
  root.setAttribute('aria-label', `Card: ${c.face.title}. ${c.face.summary}. ${c.inFiles.length ? `Uses` : `Adds`} ${c.weight} tokens, ${COPY.estimated}.${c.footer ? ` ${c.footer.text}.` : ''}${c.cost ? ` ${c.cost.text}: the header's marker lines are paid once per file.` : ''} ${c.provenance}.`);
  if (p.onActivate) {
    root.addEventListener('keydown', (e) => {
      if (e.target !== root || (e.key !== 'Enter' && e.key !== ' ')) return;
      // Enter on the card already selected falls through: the table's Enter plays it on the beast.
      if (e.key === 'Enter' && p.selected) return;
      e.preventDefault();
      e.stopPropagation();
      p.onActivate!(c.id);
    });
  }

  // 1 · top band: weight orb with "estimated", two agent sigils, the type glyph, the dog-ear (decoration only).
  // At S (132 px of text) the sigils ride on the art panel's corner so "estimated" keeps its place beside the orb.
  const sigils = el('span', 'pl-cards-sigils', Sigil('claude', c.sigils.claude), Sigil('codex', c.sigils.codex));
  // The orb says its unit (P3 gate fix 1): "+46 tok", what the line adds to its file. The inspector shows the maths.
  const top = el('div', 'pl-cards-top', el('span', 'pl-cards-orb', el('b', 'pl-cards-num', `+${c.weight}`), el('small', '', 'tok')), p.size === 'S' ? null : sigils, TypeGlyph(c.type));
  top.querySelector('.pl-cards-orb')!.setAttribute('title', `+${c.weight} tok is what this line adds to its file (tokens, ${COPY.estimated}: bytes ÷ 3)`);
  const ear = el('span', 'pl-cards-ear');
  ear.setAttribute('aria-hidden', 'true');

  // 2 · art window: a fixed 4:3 panel with a centred image and the scope ribbon on its lower-left corner.
  const art = el('div', 'pl-cards-art');
  const key = cardArt(c);
  if (key === 'imported') art.append(ImportedEmblem());
  else if (key) {
    const img = el('img', '');
    img.src = asset(`cards/card-${key}.webp`);
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.style.objectPosition = ART_FOCUS[key];
    art.append(img);
  } else art.append(svg('0 0 64 48', 'pl-cards-seal', [{ d: 'M32 9a15 15 0 1 1 0 30 15 15 0 0 1 0-30Z', fill: true }, { d: 'M26 22v-3a6 6 0 0 1 12 0v3M24 22h16v10H24Z' }]));
  art.append(el('span', 'pl-cards-scope', c.scope));
  if (p.size === 'S') art.append(sigils);

  // 3 · title plate · 4 · summary (or a marked excerpt) · 5 · footer: provenance, then the room line.
  const title = el('div', 'pl-cards-title', c.face.title);
  const summary = el('div', 'pl-cards-summary');
  const foot = el('div', 'pl-cards-foot', el('span', 'pl-cards-prov', c.provenance));
  if (c.footer) {
    // At S (the 132 px overview) the room line says the number and "here" only; M and L say "answers n cases here".
    const parts = footerParts(p.size === 'S' ? c.footer.text.replace(/^answers (\d+) cases? here/, 'answers $1 here') : c.footer.text);
    foot.append(el('span', `pl-cards-room${parts.length > 1 ? ' is-split' : ''}`, ...parts.map((t, i) => el('span', '', i > 0 ? `· ${t}` : t))));
    foot.classList.add('has-room');
  }
  if (c.cost) {
    // P4 item 2: a play that brings the block header shows its cost on the face ("+46 tok · +22 once"). The footer
    // keeps two rows in the fixed box, so the provenance yields here (as it does at S) and stays in the inspector.
    // At S the orb already says the line's tokens; the footer keeps the once-only part ("+22 once").
    const cost = el('span', 'pl-cards-cost', p.size === 'S' ? c.cost.text.replace(/^\+\d+ tok · /, '') : c.cost.text);
    cost.title = `${c.cost.files.map((f) => `${f.file}: +${f.line} tok for the line, +${f.header} once for ${BLOCK_HEADER_WHY}`).join('; ')} (tokens, ${COPY.estimated})`;
    foot.append(cost);
    foot.classList.add('has-cost');
  }

  const face = el('div', 'pl-cards-face', top, art, title, summary, foot, ear);
  root.append(face);
  paintSummary(root, summary, c, false);

  // The external Inspect control: 44 px, outside the face, never a drop target.
  root.append(button('pl-cards-inspect', svg('0 0 16 16', '', [{ d: 'M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM10.3 10.3 14 14' }]), () => p.onInspect(c.id), `Inspect ${c.face.title}`));

  if (p.drag) p.drag.bindCard(c.id, root);
  else bindInspectGestures(root, () => p.onInspect(c.id));

  views.set(root, c);
  scheduleFit();
  return root;
}

function paintSummary(root: HTMLElement, summary: HTMLElement, c: CardView, overflowed: boolean): void {
  const t = faceText(c, overflowed);
  summary.replaceChildren(el('p', 'pl-cards-text', ...inline(t.text)));
  if (t.mark) summary.append(el('p', 'pl-cards-mark', t.mark));
  root.classList.toggle('is-excerpt', !!t.mark);
  root.dataset.fit = t.fallback ? 'fallback' : t.mark ? 'excerpt' : 'fit';
}

/** Right-click and a 450 ms press open the inspector on cards that are not drag sources (DragCore does it otherwise). */
function bindInspectGestures(root: HTMLElement, open: () => void): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let x0 = 0;
  let y0 = 0;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    open();
  });
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    x0 = e.clientX;
    y0 = e.clientY;
    clear();
    timer = setTimeout(() => {
      timer = null;
      open();
    }, LONG_PRESS_MS);
  });
  root.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) >= MOVE_PX) clear();
  });
  root.addEventListener('pointerup', clear);
  root.addEventListener('pointercancel', clear);
  root.addEventListener('pointerleave', clear);
}

// ------------------------------------------------------------------ fitting by rendered pixels

/**
 * Measure every card in the document with the real fonts. A summary that overflows its three lines is replaced by a
 * marked excerpt of the exact line (never clamped silently, never shrunk). Titles are checked too: a title wider than
 * its plate sets data-title="overflow", which the pixel test fails on.
 */
export function refitCards(scope: ParentNode = document): void {
  for (const node of scope.querySelectorAll<HTMLElement>('.pl-cards-card')) {
    const c = views.get(node);
    const summary = node.querySelector<HTMLElement>('.pl-cards-summary');
    const title = node.querySelector<HTMLElement>('.pl-cards-title');
    if (!c || !summary || !title || !node.isConnected) continue;
    paintSummary(node, summary, c, false);
    const text = summary.querySelector<HTMLElement>('.pl-cards-text')!;
    if (c.face.mode !== 'excerpt' && overflows(text, summary)) paintSummary(node, summary, c, true);
    node.dataset.title = title.scrollWidth > title.clientWidth + 0.5 ? 'overflow' : 'fit';
  }
}

function overflows(text: HTMLElement, zone: HTMLElement): boolean {
  return text.scrollHeight > zone.clientHeight + 0.5 || text.scrollWidth > text.clientWidth + 0.5;
}

function scheduleFit(): void {
  if (typeof document === 'undefined') return;
  if (!queued) {
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      refitCards();
    });
  }
  // Web fonts arrive after the first paint; measure again with the real faces.
  if (!fontsHooked && document.fonts && document.fonts.status !== 'loaded') {
    fontsHooked = true;
    void document.fonts.ready.then(() => {
      fontsHooked = false;
      refitCards();
    });
  }
}
