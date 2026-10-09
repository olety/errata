// R15, "necks": a multi-headed beast never mixes its necks. Heads pair with sockets in x order, so no two necks cross,
// and a ribbon neck is at most one head height long wherever the heads have room to come down (pure, no DOM).
import { describe, expect, test } from 'bun:test';
import type { Skin } from '../src/ui/playloop/contract';
import { neckControl, quadAt, type P } from '../src/ui/playloop/room/ribbon';
import { NECK_MAX, RIGS, fitRig, headPoints, pairSockets, segmentsCross, type Pt } from '../src/ui/playloop/room/rig';

const NECKED: Skin[] = ['suite-wyrm', 'retry-hydra', 'boundary-stag', 'patch-moth', 'owl'];
const SIZES: [number, number][] = [[405, 1040], [307, 680], [310, 358], [120, 358]];
const pt = (p: P): Pt => [p.x, p.y];

/** The drawn centre line of a neck: the ribbon's quadratic, or the lantern's straight string. */
function centre(skin: Skin, s: P, p: P, anchor: boolean): Pt[] {
  if (RIGS[skin].neck === 'string') return [pt(s), pt(p)];
  const c = neckControl(s, p, anchor);
  return Array.from({ length: 33 }, (_, i) => pt(quadAt(s, c, p, i / 32)));
}

function linesCross(a: Pt[], b: Pt[]): boolean {
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) if (segmentsCross(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) return true;
  return false;
}

describe('pairSockets: heads take sockets in x order', () => {
  test('sorted inputs pair index to index; reversed heads pair the leftmost head with the leftmost socket', () => {
    expect(pairSockets([0, 1, 2], [0, 1, 2])).toEqual([0, 1, 2]);
    expect(pairSockets([3, 2, 1], [0, 1, 2])).toEqual([2, 1, 0]);
    // The rig's own order (3, 1, 0, 2, 4) on both sides is already monotone.
    expect(pairSockets([0.47, 0.15, 0.8, -0.17, 1.12], [0.43, 0.4, 0.57, 0.38, 0.77])).toEqual([0, 1, 2, 3, 4]);
  });

  test('every permutation of five heads over five sockets gives a monotone, one-to-one pairing', () => {
    const perms = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])));
    const sockets = [0.4, 0.1, 0.7, 0.25, 0.9];
    for (const heads of perms([5, 1, 3, 2, 4])) {
      const m = pairSockets(heads, sockets);
      expect(new Set(m).size).toBe(5);
      for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) if (sockets[a]! < sockets[b]!) expect(heads[m[a]!]!).toBeLessThan(heads[m[b]!]!);
    }
  });
});

describe('fitted beasts: necks never cross, and stay short', () => {
  test('for 1 to 5 heads on every skin, at every band size, no two drawn necks cross', () => {
    for (const skin of NECKED) {
      for (let n = 1; n <= 5; n++) {
        for (const [h, w] of SIZES) {
          const f = fitRig(RIGS[skin], [0, 1, 2, 3, 4].slice(0, n), h, w);
          const lines = f.heads.map((hp) => centre(skin, hp.from, hp.at, hp.socket === 0));
          for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) expect(linesCross(lines[i]!, lines[j]!)).toBe(false);
        }
      }
    }
  });

  test('any set of sockets in use pairs without a crossing chord', () => {
    for (const skin of NECKED) {
      for (let mask = 1; mask < 32; mask++) {
        const used = [0, 1, 2, 3, 4].filter((i) => mask & (1 << i));
        const f = fitRig(RIGS[skin], used, 405, 1040);
        for (const a of f.heads) for (const b of f.heads) if (a !== b) expect(segmentsCross(pt(a.from), pt(a.at), pt(b.from), pt(b.at))).toBe(false);
      }
    }
  });

  // Where five heads crowd one side of the plate, a head cannot come within one head height of its socket without
  // layering onto a neighbour: the wyrm's far-left head (all its collars sit right of centre), and the top pair of a
  // three-over-two crown over one collar (stag, moth) once the lower pair is out. Those keep the closest clear point.
  const CROWDED: Partial<Record<Skin, { from: number; sockets: number[] }>> = {
    'suite-wyrm': { from: 4, sockets: [3] },
    'boundary-stag': { from: 4, sockets: [1, 2] },
    'patch-moth': { from: 4, sockets: [1, 2] },
  };

  test('a ribbon neck is at most one head height long (the crowded five-head crowns excepted, and never longer than drawn)', () => {
    for (const skin of NECKED) {
      const rig = RIGS[skin];
      if (rig.neck !== 'ribbon') continue;
      for (let n = 1; n <= 5; n++) {
        const f = fitRig(rig, [0, 1, 2, 3, 4].slice(0, n), 405, 1040);
        for (const hp of f.heads) {
          const len = Math.hypot(hp.at.x - hp.from.x, hp.at.y - hp.from.y) / hp.box.h;
          const c = CROWDED[skin];
          if (c && n >= c.from && c.sockets.includes(hp.socket)) {
            const p = rig.heads[hp.socket]!;
            const s = rig.sockets[hp.socket]!;
            const drawn = Math.hypot((p[0] - s[0]) * (rig.plate.w / rig.plate.h), p[1] - s[1]) / rig.headScale;
            expect(len).toBeLessThanOrEqual(drawn + 0.01);
          } else {
            expect(len).toBeLessThanOrEqual(NECK_MAX + 0.01);
          }
          // Still above its socket: the neck rises to the head.
          expect(hp.at.y).toBeLessThan(hp.from.y);
        }
      }
    }
  });

  test('heads keep their sockets and the x order of their necks', () => {
    for (const skin of NECKED) {
      for (let n = 1; n <= 5; n++) {
        const used = [0, 1, 2, 3, 4].slice(0, n);
        const pts = headPoints(RIGS[skin], used);
        const f = fitRig(RIGS[skin], used, 405, 1040);
        expect(f.heads.map((h) => h.socket)).toEqual(used);
        const bySocketX = used.map((s, k) => [RIGS[skin].sockets[s]![0], pts[k]![0]] as const).sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < bySocketX.length; i++) if (bySocketX[i]![0] > bySocketX[i - 1]![0]) expect(bySocketX[i]![1]).toBeGreaterThan(bySocketX[i - 1]![1]);
      }
    }
  });
});
