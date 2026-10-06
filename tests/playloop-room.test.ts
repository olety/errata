// The room/rig worker's pure helpers: the rig data and its fit, the neck and drag ribbons, the fold, the motion clock,
// the room controls and review lock, the bind and strike cues, the boat rule and the tag packer. Fixtures and the
// synthetic sample only.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newDeck } from '../src/deck/deck';
import * as A from '../src/ui/playloop/adapter';
import { COPY, type CommitEffectView, type RoomView, type Skin } from '../src/ui/playloop/contract';
import { layout } from '../src/ui/playloop/geometry';
import { BIND_STAGGER, clearOf, controlLines, foldCues, gapBetween, packTags, reviewText, ringsText, roomControls, shortDate, strikeCues } from '../src/ui/playloop/room/logic';
import { cue, flush, resetMotion } from '../src/ui/playloop/room/motion';
import { dragControl, dragShape, foldFrames, neckControl, neckShape, quadAt } from '../src/ui/playloop/room/ribbon';
import { RIGS, fitRig } from '../src/ui/playloop/room/rig';
import { stageColumns } from '../src/ui/playloop/room/room-screen';
import { sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let fresh: () => A.PlayState;
beforeAll(async () => {
  const an = await sampleAnalysis();
  fresh = () => A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true });
});

const BODY_SKINS: Skin[] = ['suite-wyrm', 'retry-hydra', 'boundary-stag', 'patch-moth'];
const ALL = [0, 1, 2, 3, 4];
const pathPoints = (d: string) => d.split(/[MLZ]/).map((x) => x.trim()).filter(Boolean).length;

describe('the rig: one logic for every skin (§0a.22)', () => {
  test('every body skin has five sockets on its measured collars, five head points, and one fixed head scale', () => {
    for (const skin of BODY_SKINS) {
      const r = RIGS[skin];
      expect(r.sockets).toHaveLength(5);
      expect(r.heads).toHaveLength(5);
      expect(r.neckW).toHaveLength(5);
      expect(r.body).toBe(`playloop/beasts/${skin}/body.png`);
      expect(r.head).toBe(`playloop/beasts/${skin}/head.png`);
      for (const s of r.sockets) {
        // Each socket sits in a collar opening (within half a collar width of its measured centre, on its row).
        expect(r.collars.some((c) => Math.abs(s[0] - c.at[0]) <= c.w / 2 && Math.abs(s[1] - c.at[1]) < 1e-9)).toBe(true);
      }
    }
  });

  test('necks never cross: sockets and head points share one x order (3, 1, 0, 2, 4), and every head is above its socket', () => {
    for (const skin of BODY_SKINS) {
      const r = RIGS[skin];
      const order = (xs: number[]) => xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
      expect(order(r.heads.map((h) => h[0]))).toEqual([3, 1, 0, 2, 4]);
      const sx = order(r.sockets.map((s) => s[0]));
      // Sockets sharing one collar may tie on x; the order is the same where they differ.
      expect(sx.filter((i) => [3, 1, 0, 2, 4].includes(i))).toEqual(sx);
      for (let i = 0; i < 5; i++) expect(r.heads[i]![1]).toBeLessThan(r.sockets[i]![1]);
    }
  });

  test('fitted at every band size, the beast fits its box, stands on the shore, and no two head sprites overlap', () => {
    const sizes: [number, number][] = [[405, 1040], [307, 680], [310, 358], [120, 358]];
    for (const skin of [...BODY_SKINS, 'owl' as Skin]) {
      for (const [h, w] of sizes) {
        const f = fitRig(RIGS[skin], ALL, h, w);
        expect(f.h).toBeLessThanOrEqual(h + 1);
        expect(f.w).toBeLessThanOrEqual(w + 1);
        // Feet on the bottom edge: the body's opaque bottom is the box's bottom.
        expect(Math.abs(f.body!.y + RIGS[skin].bodyBox.y1 * f.body!.h - f.h)).toBeLessThan(1);
        for (const a of f.heads) {
          expect(a.box.x).toBeGreaterThanOrEqual(-1);
          expect(a.box.x + a.box.w).toBeLessThanOrEqual(f.w + 1);
          for (const b of f.heads) {
            if (a === b) continue;
            const ox = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
            const oy = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y);
            expect(ox <= 0.5 || oy <= 0.5).toBe(true);
          }
        }
      }
    }
  });

  test('the creature band at 1440 × 900 gives heads at least 44 px tall, so each head is a real drop target', () => {
    const b = layout({ w: 1440, h: 900 });
    const cols = stageColumns(b.mode, b.viewport.w);
    for (const skin of BODY_SKINS) {
      const f = fitRig(RIGS[skin], ALL, b.creature.h, cols.arena);
      for (const hp of f.heads) expect(Math.min(hp.box.w, hp.box.h) * 0.68).toBeGreaterThanOrEqual(44);
    }
  });

  test('the heron is the Event: no body, one head, no neck; the owl hangs lanterns on strings', () => {
    expect(RIGS.heron.body).toBeNull();
    expect(RIGS.heron.heads).toHaveLength(1);
    expect(RIGS.heron.neck).toBe('none');
    expect(RIGS.owl.head).toBeNull();
    expect(RIGS.owl.neck).toBe('string');
    const f = fitRig(RIGS.heron, [0], 405);
    expect(f.heads).toHaveLength(1);
    expect(f.h).toBeLessThanOrEqual(405);
  });

  test('stage columns never exceed the viewport', () => {
    for (const vp of [{ w: 1440, h: 900 }, { w: 1024, h: 768 }, { w: 390, h: 844 }]) {
      const b = layout(vp);
      const c = stageColumns(b.mode, vp.w);
      if (b.mode === 'phone') expect(c.arena).toBe(vp.w - 32);
      else expect(c.side + c.rail + c.arena + 2 * c.gap + 2 * c.pad).toBeLessThanOrEqual(vp.w);
    }
  });
});

describe('ribbons (Astra, astra-neck)', () => {
  const S = { x: 300, y: 400 };
  const P = { x: 220, y: 150 };

  test('the neck leaves the collar upward and rises all the way: Py < Cy < Sy; the anchor rises straight', () => {
    const c = neckControl(S, P);
    expect(c.y).toBeLessThan(S.y);
    expect(c.y).toBeGreaterThan(P.y);
    expect(c.x).toBeLessThan(S.x); // tilted toward the head's side
    const a = neckControl(S, { x: 300, y: 100 }, true);
    expect(a.x).toBe(300);
    for (let t = 0.05; t <= 1; t += 0.05) expect(quadAt(S, c, P, t).y).toBeLessThan(quadAt(S, c, P, t - 0.05).y + 1e-9);
  });

  test('the strip has one outline, a back face from the twist, and one ring band per repeat up to six', () => {
    const n = neckShape(S, P, 30, 40, 4);
    expect(n.front.startsWith('M')).toBe(true);
    expect(n.back).not.toBe('');
    expect(n.rings).toHaveLength(4);
    expect(neckShape(S, P, 30, 40, 1).rings).toHaveLength(1);
    expect(neckShape(S, P, 30, 40, 11).rings).toHaveLength(6);
    expect(neckShape(S, P, 30, 40, 0).rings).toHaveLength(0);
    expect(neckShape(S, { x: 300, y: 380 }, 30, 40).back).toBe('');
  });

  test('the drag ribbon never doubles back: its centre advances along the chord; a vertical drag stays straight', () => {
    for (const [from, to] of [[{ x: 100, y: 800 }, { x: 700, y: 300 }], [{ x: 500, y: 800 }, { x: 500, y: 200 }], [{ x: 600, y: 300 }, { x: 100, y: 700 }]] as const) {
      const c = dragControl(from, to);
      const L = Math.hypot(to.x - from.x, to.y - from.y);
      const u = { x: (to.x - from.x) / L, y: (to.y - from.y) / L };
      let prev = -1;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const q = quadAt(from, c, to, t);
        const along = (q.x - from.x) * u.x + (q.y - from.y) * u.y;
        expect(along).toBeGreaterThan(prev);
        prev = along;
      }
      expect(dragShape(from, to).startsWith('M')).toBe(true);
    }
    const v = dragControl({ x: 500, y: 800 }, { x: 500, y: 200 });
    expect(v.x).toBeCloseTo(500, 6);
  });

  test('the fold runs the head back down its neck and rests flattened just below the socket', () => {
    const n = neckShape(S, P, 30, 40, 0);
    const fr = foldFrames(n, 100, 0.9, -1);
    expect(fr[0]).toMatchObject({ dx: 0, dy: 0, sy: 1 });
    const last = fr.at(-1)!;
    expect(last.sy).toBe(0.3);
    // The collar ends below the socket (P + dy > S.y), on the head's side.
    expect(P.y + last.dy).toBeGreaterThan(S.y);
    expect(P.x + last.dx).toBeLessThan(S.x);
    // Every neck keyframe has the same number of points, so CSS can interpolate the path.
    const counts = new Set(fr.map((k) => pathPoints(k.neck)));
    expect(counts.size).toBe(1);
  });
});

describe('the motion clock: once per key, interruptible', () => {
  test('a cue plays once, continues across repaints with a negative delay, then shows the end state', () => {
    resetMotion();
    expect(cue('k', 500, 0, 1000)).toEqual({ play: true, delay: 0 });
    expect(cue('k', 500, 0, 1200)).toEqual({ play: true, delay: -200 });
    expect(cue('k', 500, 0, 1600).play).toBe(false);
    expect(cue('stagger', 100, 180, 2000)).toEqual({ play: true, delay: 180 });
  });

  test('flush ends every running cue at once; later keys still play', () => {
    resetMotion();
    cue('a', 1000, 0, 0);
    flush(10);
    expect(cue('a', 1000, 0, 20).play).toBe(false);
    expect(cue('b', 1000, 0, 30).play).toBe(true);
  });
});

function room(s: A.PlayState): RoomView {
  return A.selectRoom(s)!;
}
function stampAll(s: A.PlayState, stamp: 'issue' | 'pivot' | 'unclear'): A.PlayState {
  for (const h of room(s).heads) s = A.actStamp(s, h.caseId, stamp);
  return s;
}

describe('room controls and the review lock (§0a.13–14, CONTRACT.md rule 9)', () => {
  test('Deal waits for every stamp and says how many heads are left; then it deals', () => {
    let s = fresh();
    const v0 = room(s);
    expect(v0.review.remaining).toBe(3);
    const c0 = roomControls(v0);
    expect(c0.map((c) => [c.id, c.enabled, c.why])).toEqual([['deal', false, '3 heads still to stamp']]);
    s = A.actStamp(s, v0.heads[0]!.caseId, 'issue');
    s = A.actStamp(s, v0.heads[1]!.caseId, 'issue');
    expect(reviewText(room(s))).toBe('1 head still to stamp');
    s = A.actStamp(s, v0.heads[2]!.caseId, 'issue');
    expect(roomControls(room(s)).map((c) => [c.id, c.enabled])).toEqual([['deal', true]]);
  });

  test('while dealt: Pull the hand back, the finalizes line and the pull-back hint; after the play: Continue', () => {
    let s = A.actDeal(stampAll(fresh(), 'issue'));
    const v = room(s);
    expect(roomControls(v).map((c) => c.id)).toEqual(['pull-back']);
    expect(controlLines(v)).toEqual([COPY.finalizes, COPY.pullBack]);
    s = A.actPlay(s, v.hand[0]!.id, 'beast').state;
    expect(roomControls(room(s)).map((c) => [c.id, c.enabled])).toEqual([['continue', true]]);
  });

  test('every head set aside offers Continue at once and never the boat; all-unclear offers the free skip', () => {
    const aside = stampAll(fresh(), 'pivot');
    const va = room(aside);
    expect(va.offer).toBe('continue-all-set-aside');
    expect(roomControls(va).map((c) => [c.id, c.enabled])).toEqual([['continue', true]]);
    expect(clearOf(va)).toBeNull();
    const unclear = stampAll(fresh(), 'unclear');
    expect(roomControls(room(unclear)).map((c) => c.id)).toEqual(['skip']);
    const skipped = A.actSkip(unclear).state;
    expect(clearOf(room(skipped))).toBeNull();
  });

  test('the Event: Continue waits for its stamp; a change of plan lets it go', () => {
    let s = fresh();
    for (let i = 0; i < 6 && A.selectScreen(s).kind !== 'event'; i++) {
      s = A.actDeal(stampAll(s, 'issue'));
      const v = room(s);
      s = v.hand.length ? A.actPlay(s, v.hand[0]!.id, 'beast').state : A.actSkip(s).state;
      s = A.actAdvance(s);
    }
    const ev = room(s);
    expect(ev.kind).toBe('event');
    expect(ev.beast.skin).toBe('heron');
    expect(roomControls(ev).map((c) => [c.id, c.enabled, c.why])).toEqual([['continue', false, '1 head still to stamp']]);
    const flown = A.actStamp(s, ev.heads[0]!.caseId, 'pivot');
    expect(room(flown).heads[0]!.state).toBe('heron');
    expect(roomControls(room(flown))[0]).toMatchObject({ id: 'continue', enabled: true });
    const problem = room(A.actStamp(s, ev.heads[0]!.caseId, 'issue'));
    expect(problem.kind).toBe('encounter');
    expect(problem.beast.skin).toBe('heron');
  });
});

describe('animation cues come from results and effects, once per id (CONTRACT.md rule 5)', () => {
  test('the bind cascade folds exactly result.bound, in its order, 90 ms apart, keyed by the result id', () => {
    const s0 = A.actDeal(stampAll(fresh(), 'issue'));
    const { state, result } = A.actPlay(s0, room(s0).hand[0]!.id, 'beast');
    const v = room(state);
    const cues = foldCues(v, null);
    expect([...cues.keys()]).toEqual(result.bound);
    result.bound.forEach((id, i) => expect(cues.get(id)).toEqual({ key: `fold:r${result.id}:${id}`, offset: i * BIND_STAGGER }));
    // A play's own effect repeats result.bound and adds nothing.
    const playEffect: CommitEffectView = { id: 9, kind: 'play', bound: result.bound, unbound: [] };
    expect(foldCues(v, playEffect).size).toBe(result.bound.length);
    expect(clearOf(v)).toBe('boat');
  });

  test('a later bind (an accept) folds once per effect id; heads that are not bound never fold', () => {
    const s0 = A.actDeal(stampAll(fresh(), 'issue'));
    const s1 = A.actSkip(s0).state;
    const v = room(s1);
    expect(v.heads.every((h) => h.state === 'standing')).toBe(true);
    const fx: CommitEffectView = { id: 4, kind: 'accept', bound: [v.heads[0]!.caseId], unbound: [] };
    expect(foldCues(v, fx).size).toBe(0);
    const bound = { ...v, heads: v.heads.map((h, i) => (i === 0 ? { ...h, state: 'bound' as const } : h)) };
    expect(foldCues(bound, fx).get(v.heads[0]!.caseId)).toEqual({ key: `fold:e4:${v.heads[0]!.caseId}`, offset: 0 });
  });

  test('standing heads strike only on the strike beat, each once; the room sinks, never boats', () => {
    const s1 = A.actSkip(A.actDeal(stampAll(fresh(), 'issue'))).state;
    const v = room(s1);
    expect(strikeCues(v, 'clear').size).toBe(0);
    const st = strikeCues(v, 'strike');
    expect([...st.keys()]).toEqual(v.result!.standing);
    expect(clearOf(v)).toBe('sink');
    expect(v.beast.pips.text).toBe('0/3 confirmed addressed · 0 unreviewed');
  });
});

describe('tags (§0a.19): every hit region ≥ 44 px, ≥ 8 px apart, never over another head', () => {
  const req = (i: number, x: number, y = 100) => ({ caseId: `c${i}`, x, y, fullW: 170, stackW: 100, stackH: 96 });

  test('wide spacing keeps the one-row strip; tight spacing falls back to two rows, then to the compact knob', () => {
    const wide = packTags([req(0, 200), req(1, 400), req(2, 600)], { bounds: { w: 900, h: 400 } });
    expect(wide.map((t) => t.mode)).toEqual(['full', 'full', 'full']);
    const mid = packTags([req(0, 200), req(1, 320), req(2, 440)], { bounds: { w: 900, h: 400 } });
    expect(mid.map((t) => t.mode)).toEqual(['stacked', 'stacked', 'stacked']);
    const tight = packTags([req(0, 200), req(1, 260), req(2, 320)], { bounds: { w: 900, h: 400 } });
    expect(new Set(tight.map((t) => t.mode)).has('full')).toBe(false);
  });

  test('placements stay inside the box, keep 8 px apart and avoid other heads', () => {
    const obstacles = [{ owner: 'c1', x: 180, y: 150, w: 60, h: 60 }];
    for (const spacing of [40, 60, 90, 130, 200]) {
      const reqs = [0, 1, 2, 3, 4].map((i) => req(i, 60 + i * spacing, 120));
      const out = packTags(reqs, { bounds: { w: 700, h: 360 }, obstacles });
      for (const a of out) {
        expect(a.h).toBeGreaterThanOrEqual(44);
        expect(a.w).toBeGreaterThanOrEqual(44);
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(700);
        for (const b of out) if (a !== b) expect(gapBetween(a, b)).toBeGreaterThanOrEqual(8);
        for (const o of obstacles) if (o.owner !== a.caseId) expect(gapBetween(o, a) > 0 || a.x >= o.x + o.w || a.y >= o.y + o.h || a.x + a.w <= o.x || a.y + a.h <= o.y).toBe(true);
      }
    }
  });

  test('rings say what they count; dates shorten for the tag only', () => {
    expect(ringsText({ count: 3, counts: 'failed runs' })).toBe('3 failed runs');
    expect(ringsText({ count: 1, counts: 'failed runs' })).toBe('1 failed run');
    expect(ringsText({ count: 1, counts: 'edits' })).toBe('1 edit');
    expect(shortDate('2026-09-23')).toBe('09-23');
    expect(shortDate(null)).toBeNull();
  });
});

describe('the room folder keeps the rules', () => {
  const dir = join(import.meta.dir, '..', 'src', 'ui', 'playloop', 'room');
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);

  test('imports only the contract, the base layer and its own files; never the adapter or the engine', () => {
    for (const [f, src] of sources) {
      for (const m of src.matchAll(/from '([^']+)'/g)) expect([f, /^(\.\.\/contract|\.\.\/cards|\.\/[a-z-]+)$/.test(m[1]!)]).toEqual([f, true]);
      expect(src.includes('import.meta.env')).toBe(false);
    }
  });

  test('never the banned words; every class is prefixed pl-room-', () => {
    for (const [f, src] of sources) {
      const lower = src.toLowerCase();
      for (const w of ['prevented', 'killed', 'defeated', 'damage', 'saved time', ' worked', ' fired']) expect([f, w, lower.includes(w)]).toEqual([f, w, false]);
    }
    const css = readFileSync(join(dir, 'room.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!).filter((c) => !/^\d/.test(c));
    for (const c of classes) expect([c, c.startsWith('pl-room') || c.startsWith('is-')]).toEqual([c, true]);
    expect(/gradient\(/.test(css)).toBe(false);
    expect(/#fff\b|#ffffff\b|#000\b|#000000\b/i.test(css)).toBe(false);
  });
});
