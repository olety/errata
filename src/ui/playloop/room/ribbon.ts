// Owner: room/rig. Paper ribbons: the necks (socket → head collar, under the body) and the drag ribbon (card → pointer).
// The geometry is pure (tested without a DOM): a quadratic centre line offset by a tapering half-width along its
// normal, with one paper twist that shows the ribbon's back face, and ring bands across the strip for neck rings.

import { SVG_NS } from './dom';

export interface P {
  x: number;
  y: number;
}

export function quadAt(a: P, c: P, b: P, t: number): P {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

export function quadTangent(a: P, c: P, b: P, t: number): P {
  const x = 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x);
  const y = 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y);
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

/**
 * The neck's control point: it leaves the collar along the collar's axis (up, tilted toward the head) and bends to
 * arrive at the head collar from below.
 */
export function neckControl(s: P, p: P): P {
  const dx = p.x - s.x;
  const dy = p.y - s.y;
  const d = Math.hypot(dx, dy) || 1;
  // Axis: mostly up, leaning outward by the head's side offset.
  const side = Math.max(-1, Math.min(1, dx / d));
  const ax = side * 0.45;
  const ay = -1;
  const al = Math.hypot(ax, ay);
  const k = 0.55 * d;
  const c = { x: s.x + (ax / al) * k, y: s.y + (ay / al) * k };
  // Never above the head point (the neck must arrive from below).
  if (c.y < p.y + 0.12 * d) c.y = p.y + 0.12 * d;
  return c;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function polygon(left: P[], right: P[]): string {
  if (!left.length) return '';
  const pts = [...left, ...[...right].reverse()];
  return `M${pts.map((q) => `${r1(q.x)} ${r1(q.y)}`).join(' L')} Z`;
}

export interface NeckShape {
  /** The ribbon's front face (the whole strip). */
  front: string;
  /** The back face shown by the twist, drawn over the front; empty for very short necks. */
  back: string;
  /** Ring bands across the strip: [x1, y1, x2, y2]. */
  rings: [number, number, number, number][];
  /** The centre line's control point (for tests and the fold). */
  control: P;
}

/** The twist: a full turn between t0 and t1; the width narrows to `pinch` and the back face shows mid-turn. */
const TWIST = { t0: 0.34, t1: 0.7, pinch: 0.42 };

function twistPhase(t: number): number {
  const u = Math.max(0, Math.min(1, (t - TWIST.t0) / (TWIST.t1 - TWIST.t0)));
  return Math.cos(2 * Math.PI * u);
}

/**
 * A paper neck from socket `s` to head point `p`, width `w0` at the socket tapering to `w1` at the head, with `rings`
 * ring bands near the head end (where the neck shows above the body).
 */
export function neckShape(s: P, p: P, w0: number, w1: number, rings = 0, samples = 28): NeckShape {
  const c = neckControl(s, p);
  const len = Math.hypot(p.x - s.x, p.y - s.y);
  const left: P[] = [];
  const right: P[] = [];
  const bl: P[] = [];
  const br: P[] = [];
  const backRuns: string[] = [];
  const twist = len > 40;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const q = quadAt(s, c, p, t);
    const tg = quadTangent(s, c, p, t);
    const n = { x: -tg.y, y: tg.x };
    const f = twist ? twistPhase(t) : 1;
    const half = ((w0 + (w1 - w0) * t) / 2) * (TWIST.pinch + (1 - TWIST.pinch) * Math.abs(f));
    const L = { x: q.x + n.x * half, y: q.y + n.y * half };
    const R = { x: q.x - n.x * half, y: q.y - n.y * half };
    left.push(L);
    right.push(R);
    if (f < 0) {
      bl.push(L);
      br.push(R);
    } else if (bl.length) {
      backRuns.push(polygon(bl.splice(0), br.splice(0)));
    }
  }
  if (bl.length) backRuns.push(polygon(bl, br));
  const ringLines: NeckShape['rings'] = [];
  const nR = Math.max(0, Math.min(8, Math.floor(rings)));
  for (let k = 0; k < nR; k++) {
    const t = nR === 1 ? 0.8 : 0.72 + (0.2 * k) / (nR - 1);
    const q = quadAt(s, c, p, t);
    const tg = quadTangent(s, c, p, t);
    const n = { x: -tg.y, y: tg.x };
    const half = (w0 + (w1 - w0) * t) / 2;
    ringLines.push([r1(q.x + n.x * half), r1(q.y + n.y * half), r1(q.x - n.x * half), r1(q.y - n.y * half)]);
  }
  return { front: polygon(left, right), back: backRuns.join(' '), rings: ringLines, control: c };
}

/** The drag ribbon's centre: from the card to the pointer, sagging with gravity in proportion to the distance. */
export function dragControl(from: P, to: P): P {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  // A quadratic never crosses itself; the control sits below the chord's midpoint, so the strip hangs.
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + Math.min(140, 0.25 * d) };
}

/** A constant-width paper strip from the card to the pointer (14 px), with the same twist as the necks. */
export function dragShape(from: P, to: P, width = 14): { front: string; back: string } {
  const c = dragControl(from, to);
  const left: P[] = [];
  const right: P[] = [];
  const bl: P[] = [];
  const br: P[] = [];
  const back: string[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const q = quadAt(from, c, to, t);
    const tg = quadTangent(from, c, to, t);
    const n = { x: -tg.y, y: tg.x };
    const f = twistPhase(t);
    const half = (width / 2) * (TWIST.pinch + (1 - TWIST.pinch) * Math.abs(f));
    const L = { x: q.x + n.x * half, y: q.y + n.y * half };
    const R = { x: q.x - n.x * half, y: q.y - n.y * half };
    left.push(L);
    right.push(R);
    if (f < 0) {
      bl.push(L);
      br.push(R);
    } else if (bl.length) back.push(polygon(bl.splice(0), br.splice(0)));
  }
  if (bl.length) back.push(polygon(bl, br));
  return { front: polygon(left, right), back: back.join(' ') };
}

/**
 * The paper ribbon overlay for drags (replaces the mount's plain line): the same shape as `ribbonLayer` in mount.ts.
 * The mount skips draw() under reduced motion, so no ribbon shows there.
 */
export function RibbonLayer(): { el: SVGSVGElement; draw(from: P, to: P | null): void } {
  const svgEl = document.createElementNS(SVG_NS, 'svg');
  svgEl.setAttribute('class', 'pl-room-ribbon-layer');
  svgEl.setAttribute('aria-hidden', 'true');
  svgEl.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:50;overflow:visible');
  const front = document.createElementNS(SVG_NS, 'path');
  front.setAttribute('fill', '#F3E7D1');
  front.setAttribute('stroke', '#41291F');
  front.setAttribute('stroke-width', '1.4');
  front.setAttribute('stroke-linejoin', 'round');
  const back = document.createElementNS(SVG_NS, 'path');
  back.setAttribute('fill', '#E3D2B3');
  back.setAttribute('stroke', '#41291F');
  back.setAttribute('stroke-width', '1');
  svgEl.append(front, back);
  return {
    el: svgEl,
    draw(from, to) {
      svgEl.setAttribute('visibility', to ? 'visible' : 'hidden');
      if (!to) return;
      const s = dragShape(from, to);
      front.setAttribute('d', s.front);
      back.setAttribute('d', s.back);
    },
  };
}
