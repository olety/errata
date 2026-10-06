// Owner: cards/layout. The dealt hand (play-loop §1, §3, §0a.15, §0a.18): a rotated fan when the wood allows a rotated
// M, flat when tight, a snapping carousel on phones where a sideways swipe scrolls and never plays a card.
// Import from ../contract only. Never the adapter or the engine.
import type { Bands, CardView, ControllerApi, DropBinder, UiView } from '../contract';
import { Card } from './card';
import { el } from './dom';
import { Comparison } from './inspector';
import './cards.css';

export interface HandProps {
  cards: CardView[];
  bands: Bands;
  ui: UiView;
  api: ControllerApi;
  drag: DropBinder;
}

/** The hand always reserves three slots, so the books and piles never move when one or two cards are dealt. */
export const HAND_SLOTS = 3;

/** Per-card rotation (degrees) and drop (px) for a fan of n cards. Flat and carousel hands sit level. */
export function fanSlots(n: number, fan: Bands['fan']): { rotate: number; dy: number }[] {
  if (fan !== 'rotated' || n < 2) return Array.from({ length: n }, () => ({ rotate: 0, dy: 0 }));
  const mid = (n - 1) / 2;
  return Array.from({ length: n }, (_, i) => {
    const t = (i - mid) / mid;
    return { rotate: Math.round(6 * t * 10) / 10, dy: Math.round(10 * t * t) };
  });
}

/** Selection memory for the draft comparison: the previous and the current selected draft. */
export interface Pair {
  prev: string | null;
  cur: string | null;
}

/**
 * Selecting one draft and then another compares them (§0a, "more fun"). Deselecting clears the pair; selecting a card
 * outside the hand starts over.
 */
export function nextPair(t: Pair, selected: string | null, hand: readonly string[]): Pair {
  if (selected === t.cur) return t;
  if (!selected) return { prev: null, cur: null };
  if (!hand.includes(selected)) return { prev: null, cur: selected };
  return { prev: t.cur && hand.includes(t.cur) ? t.cur : null, cur: selected };
}

let pair: Pair = { prev: null, cur: null };
let lastHand = '';
let dismissed: string | null = null;

/** The dealt hand: a fan when the wood allows, flat when tight, a snapping carousel on phones (bands.fan). */
export function Hand(p: HandProps): HTMLElement {
  const b = p.bands;
  const ids = p.cards.map((c) => c.id);
  pair = nextPair(pair, p.ui.selected, ids);
  const root = el('div', `pl-cards-hand pl-cards-hand-${b.fan}${p.ui.reducedMotion ? ' pl-cards-still' : ''}`);
  root.setAttribute('aria-label', 'Your hand');
  root.style.setProperty('--pl-hand-gap', `${b.cards.gap}px`);
  if (b.fan !== 'carousel') root.style.width = `${HAND_SLOTS * b.card.w + (HAND_SLOTS - 1) * b.cards.gap}px`;
  else root.style.setProperty('--pl-hand-pad', `${Math.max(0, (b.viewport.w - 32 - b.card.w) / 2)}px`);

  // Cards deal in once per dealt hand (a committed act); a repaint of the same hand never replays it.
  const handKey = ids.join('|');
  const dealt = handKey !== '' && handKey !== lastHand && !p.ui.reducedMotion;
  lastHand = handKey;
  const slots = fanSlots(p.cards.length, b.fan);
  p.cards.forEach((c, i) => {
    const node = Card({ card: c, size: b.card.size, selected: p.ui.selected === c.id, drag: p.drag, onInspect: (id) => p.api.inspect({ cardId: id }), onActivate: (id) => p.api.select(id) });
    const s = slots[i]!;
    if (s.rotate || s.dy) {
      node.style.rotate = `${s.rotate}deg`;
      node.style.marginTop = `${s.dy}px`;
    }
    node.style.setProperty('--pl-deal-i', String(i));
    if (dealt) node.classList.add('is-dealt');
    if (p.ui.drag?.cardId === c.id && p.ui.drag.target && p.ui.drag.target.kind !== 'beast') node.classList.add('is-aimed');
    root.append(node);
  });

  // The draft comparison: two playPreviews on the same proposal, side by side, until the player closes it or moves on.
  const a = pair.prev ? p.cards.find((c) => c.id === pair.prev) : undefined;
  const z = pair.cur ? p.cards.find((c) => c.id === pair.cur) : undefined;
  const key = a && z ? `${a.id}|${z.id}` : null;
  if (a && z && a.playPreview && z.playPreview && !p.ui.inspect && key !== dismissed && !b.flow) {
    root.append(
      Comparison({
        a,
        b: z,
        layout: b.mode === 'phone' ? 'sheet' : 'side',
        onClose: () => {
          dismissed = key;
          root.querySelector('.pl-cards-compare')?.remove();
        },
        onInspect: (id) => p.api.inspect({ cardId: id }),
      }),
    );
  }
  return root;
}
