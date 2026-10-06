// Layout clamps (play-loop §0a.17–19): the table from Astra's geometry, row widths, the fan, phone tabs and scrolling.
import { describe, expect, test } from 'bun:test';
import { layout, ROTATED_M_WOOD } from '../src/ui/playloop/geometry';

describe('layout(viewport) → bands', () => {
  const rows = [
    { w: 1440, h: 900, mode: 'desktop', header: 90, sky: 72, creature: 405, wood: 283, rowWidth: 1168, fan: 'flat' },
    { w: 1024, h: 768, mode: 'tablet', header: 90, sky: 45, creature: 307, wood: 276, rowWidth: 1008, fan: 'flat' },
    { w: 390, h: 844, mode: 'phone', header: 96, sky: 0, creature: 310, wood: 388, rowWidth: 390, fan: 'carousel' },
  ] as const;
  for (const r of rows) {
    test(`${r.w}×${r.h}: header ${r.header} · sky ${r.sky} · creature ${r.creature} · wood ${r.wood} · status 50`, () => {
      const b = layout({ w: r.w, h: r.h });
      expect(b.mode).toBe(r.mode);
      expect([b.header.h, b.sky.h, b.creature.h, b.wood.h, b.status.h]).toEqual([r.header, r.sky, r.creature, r.wood, 50]);
      // The bands tile the viewport exactly, and the creature's feet stand on the shore.
      expect(b.header.h + b.sky.h + b.creature.h + b.wood.h + b.status.h).toBe(r.h);
      expect(b.creature.y + b.creature.h).toBe(b.shoreY);
      expect(b.wood.y).toBe(b.shoreY);
      expect(b.rowWidth).toBe(r.rowWidth);
      expect(b.rowWidth).toBeLessThanOrEqual(r.w);
      expect(b.fan).toBe(r.fan);
      expect(b.card).toEqual({ size: 'M', w: 176, h: 246 });
      expect(b.scroll).toBe(false);
    });
  }

  test('the creature cap is a ceiling: a tall viewport keeps the wood and caps the creature', () => {
    const b = layout({ w: 1440, h: 1400 });
    expect(b.creature.h).toBe(b.creature.cap);
    expect(b.wood.h).toBeGreaterThanOrEqual(276);
    expect(b.fan).toBe(b.wood.h >= ROTATED_M_WOOD ? 'rotated' : 'flat');
  });

  test('phones get book tabs and a pile rail, each at least 44 px wide; Open is a rail item, never a drop target', () => {
    const b = layout({ w: 390, h: 844 });
    expect(b.books.mode).toBe('tabs');
    expect(b.piles.mode).toBe('rail');
    expect(b.books.w).toBeGreaterThanOrEqual(44);
    expect(b.touch).toEqual({ min: 44, gap: 8 });
  });

  test('safe-area insets come off first; a stage too short scrolls instead of shrinking', () => {
    const inset = layout({ w: 390, h: 844, insets: { top: 47, bottom: 34 } });
    expect(inset.header.y).toBe(47);
    expect(inset.creature.h).toBeLessThan(310);
    const short = layout({ w: 1024, h: 500 });
    expect(short.scroll).toBe(true);
    expect(short.wood.h).toBeGreaterThanOrEqual(276);
    expect(short.creature.h).toBeGreaterThanOrEqual(120);
  });
});
