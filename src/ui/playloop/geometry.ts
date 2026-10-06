// Layout clamps (play-loop §0a.17–19, Astra's geometry). A pure function from the viewport to the screen's bands.
// The creature's height is a ceiling, never a minimum: the wood always keeps room for a flat M hand, the header for
// the route, and the status bar its 50 px. Safe-area insets are subtracted first.

import type { Bands } from './contract';

export const CARD = { S: { w: 148, h: 207 }, M: { w: 176, h: 246 }, L: { w: 208, h: 291 } } as const;
/** A rotated M card at 6° plus lift, shadow and padding (Astra §3): 246·cos 6° + 176·sin 6° + 30. */
export const ROTATED_M_WOOD = 293;
export const STATUS_H = 50;
export const TOUCH = { min: 44, gap: 8 } as const;
/** The creature never gets less than this; below it the screen scrolls instead of shrinking text. */
export const MIN_CREATURE = 120;

export interface Viewport {
  w: number;
  h: number;
  /** Safe-area insets (notch, home bar), subtracted before the clamps. */
  insets?: { top?: number; bottom?: number; left?: number; right?: number };
}

function modeOf(w: number): Bands['mode'] {
  if (w < 600) return 'phone';
  if (w < 1200) return 'tablet';
  return 'desktop';
}

export function layout(v: Viewport): Bands {
  const top = v.insets?.top ?? 0;
  const bottom = v.insets?.bottom ?? 0;
  const side = (v.insets?.left ?? 0) + (v.insets?.right ?? 0);
  const W = v.w - side;
  const H0 = v.h - top - bottom;
  const mode = modeOf(W);
  // T = header; B = minimum wood: a flat M hand (desktop and tablet), or card + clearance + book tabs + pile rail + gaps (phone).
  const T = mode === 'phone' ? 96 : 90;
  const B = mode === 'phone' ? CARD.M.h + 30 + TOUCH.min + TOUCH.min + 24 : CARD.M.h + 30;
  const capPct = mode === 'tablet' ? 0.4 : 0.45;
  // Too short for the clamps: lay out at the minimum heights and let the page scroll.
  const scroll = H0 - STATUS_H - B - T < MIN_CREATURE;
  const H = scroll ? T + MIN_CREATURE + B + STATUS_H : H0;
  const shoreY = Math.min(Math.round(0.63 * H), H - STATUS_H - B);
  const cap = Math.round(capPct * H);
  const creatureH = Math.max(0, Math.min(cap, shoreY - T));
  const sky = shoreY - T - creatureH;
  const wood = H - STATUS_H - shoreY;
  const widths =
    mode === 'desktop'
      ? { books: { mode: 'props' as const, w: 144, gap: 12 }, cards: { gap: 12 }, piles: { mode: 'props' as const, w: 96, gap: 12 }, groupGap: 64, margin: 48 }
      : mode === 'tablet'
        ? { books: { mode: 'props' as const, w: 104, gap: 8 }, cards: { gap: 8 }, piles: { mode: 'props' as const, w: 80, gap: 8 }, groupGap: 48, margin: 32 }
        : { books: { mode: 'tabs' as const, w: Math.floor((W - 32 - TOUCH.gap) / 2), gap: TOUCH.gap }, cards: { gap: 12 }, piles: { mode: 'rail' as const, w: Math.floor((W - 32 - TOUCH.gap) / 2), gap: TOUCH.gap }, groupGap: 0, margin: 32 };
  const rowWidth =
    mode === 'phone'
      ? W
      : 2 * widths.books.w + widths.books.gap + 3 * CARD.M.w + 2 * widths.cards.gap + 2 * widths.piles.w + widths.piles.gap + widths.groupGap + widths.margin;
  const fan: Bands['fan'] = mode === 'phone' ? 'carousel' : wood >= ROTATED_M_WOOD ? 'rotated' : 'flat';
  return {
    viewport: { w: v.w, h: v.h },
    mode,
    header: { y: top, h: T },
    sky: { y: top + T, h: sky },
    creature: { y: top + T + sky, h: creatureH, cap },
    wood: { y: top + shoreY, h: wood },
    status: { y: top + H - STATUS_H, h: STATUS_H },
    shoreY: top + shoreY,
    card: { size: 'M', w: CARD.M.w, h: CARD.M.h },
    fan,
    ...widths,
    rowWidth,
    scroll,
    touch: { ...TOUCH },
  };
}
