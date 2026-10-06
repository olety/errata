// Owner: room/rig. Paper ribbons: the necks (socket → head collar, under the body) and the drag ribbon (card → pointer).
// Geometry after Astra's answer (2026-10-07, astra-neck): a quadratic centre line whose control point leaves the collar
// along its axis and keeps the curve rising, so the neck reaches the head from below; a tapering half-width offset
// along the normal; one stylized half-twist (the back face shows on the head side); ring bands as short ribbon
// sections across the strip. Pure functions, tested without a DOM.

import { SVG_NS } from './dom';

export interface P {
  x: number;
  y: number;
}

const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: P, s: number): P => ({ x: a.x * s, y: a.y * s });
const len = (a: P): number => Math.hypot(a.x, a.y);
const clamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x));
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => t * t * (3 - 2 * t);
const r1 = (n: number): number => Math.round(n * 10) / 10;

export function quadAt(a: P, c: P, b: P, t: number): P {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function velocity(a: P, c: P, b: P, t: number): P {
  return mul(add(mul(sub(c, a), 1 - t), mul(sub(b, c), t)), 2);
}

/**
 * The neck's control point. Axis a = normalize(0.18·sign(Px − Sx), −1) (straight up for the anchor), D = Sy − Py,
 * C = S + a·0.55·D/(−a_y): the curve leaves the collar along a and, since Py < Cy < Sy, rises all the way to the head.
 * A head that is not above its socket (never in RIGS) falls back to the chord's midpoint.
 */
export function neckControl(s: P, p: P, anchor = false): P {
  const D = s.y - p.y;
  if (D <= 1) return mul(add(s, p), 0.5);
  const ax = anchor ? 0 : 0.18 * Math.sign(p.x - s.x);
  const l = Math.hypot(ax, 1);
  const a = { x: ax / l, y: -1 / l };
  return add(s, mul(a, (0.55 * D) / -a.y));
}

export interface Ribbon {
  s: P;
  c: P;
  p: P;
  /** Half-width at t (twist applied). */
  half(t: number): number;
  /** A closed outline of the strip between t = a and t = b, its width scaled by k; always N + 1 points a side. */
  section(a: number, b: number, k?: number): string;
}

/** The half-twist: z = smoothstep(clamp((t − 0.42)/0.22)); width × max(0.08, |cos(π z)|); back face from t = 0.53. */
export const TWIST_BACK = 0.53;
function twistFactor(t: number): number {
  const z = smooth(clamp((t - 0.42) / 0.22));
  return Math.max(0.08, Math.abs(Math.cos(Math.PI * z)));
}

export function ribbon(s: P, c: P, p: P, w0: number, w1: number, o: { twist?: boolean; N?: number; cap?: number; bendLimit?: number } = {}): Ribbon {
  const N = Math.max(8, Math.round(o.N ?? 32));
  const cap = o.cap ?? 0;
  const acc = { x: 2 * (s.x - 2 * c.x + p.x), y: 2 * (s.y - 2 * c.y + p.y) };
  // Astra (astra-rig, 2026-10-07): with a bend limit, the half-width stays below bendLimit × the local bend radius,
  // smoothly, so a short curved neck's inner edge never folds back into a cusp (the "kink").
  const half = (t: number) => {
    const wanted = 0.5 * mix(w0, w1, t) * (o.twist ? twistFactor(t) : 1);
    if (o.bendLimit === undefined) return wanted;
    const v = velocity(s, c, p, t);
    const speed = len(v);
    const curvature = speed > 1e-6 ? Math.abs(v.x * acc.y - v.y * acc.x) / (speed * speed * speed) : 0;
    return wanted / Math.hypot(1, (wanted * curvature) / o.bendLimit);
  };
  const edge = (t: number, side: number, k: number): P => {
    const v = velocity(s, c, p, t);
    const l = len(v) || 1;
    const u = mul(v, 1 / l);
    const n = { x: -u.y, y: u.x };
    // Cap overdraw: the ends run a little past S and P along the tangent, hidden behind the collar art.
    const ext = t <= 0 ? -cap : t >= 1 ? cap : 0;
    return add(add(quadAt(s, c, p, t), mul(u, ext)), mul(n, side * k * half(t)));
  };
  return {
    s,
    c,
    p,
    half,
    section(a, b, k = 1) {
      a = clamp(a);
      b = clamp(b);
      if (b <= a || k <= 0) return '';
      const ts = Array.from({ length: N + 1 }, (_, i) => mix(a, b, i / N));
      const pts = [...ts.map((t) => edge(t, 1, k)), ...ts.slice().reverse().map((t) => edge(t, -1, k))];
      return `M${pts.map((q) => `${r1(q.x)} ${r1(q.y)}`).join(' L')} Z`;
    },
  };
}

export interface NeckShape {
  /** The strip's outline (paper fill, then drawn again as the ink outline). */
  front: string;
  /** The back face the twist shows (t ≥ 0.53), darker paper; empty for very short necks. */
  back: string;
  /** Ring bands: short filled sections across the strip (one per repeat, at most six; the tag text says the count). */
  rings: string[];
  control: P;
  /** The ribbon itself, for the fold (section(0, u, u) shortens it along the same curve). */
  rib: Ribbon;
  twist: boolean;
}

/**
 * A paper neck from socket `s` to head point `p`, width `w0` at the socket tapering to `w1` at the head, with
 * `rings` ring bands at t = i/(m+1), m clamped to 1–6 when any.
 */
export function neckShape(s: P, p: P, w0: number, w1: number, rings = 0, o: { anchor?: boolean; band?: number } = {}): NeckShape {
  const c = neckControl(s, p, o.anchor);
  // Short necks (P2 rig tuning): no half-twist, and the width yields to the bend so the strip never kinks.
  const twist = false;
  const rib = ribbon(s, c, p, w0, w1, { twist, cap: 2, N: 48, bendLimit: 0.7 });
  // One band per repeat up to six; past six the tag's text carries the exact count.
  const m = rings > 0 ? Math.max(1, Math.min(6, Math.round(rings))) : 0;
  const band = o.band ?? 3;
  const ringsD = Array.from({ length: m }, (_, i) => {
    const t = (i + 1) / (m + 1);
    const dt = band / (2 * (len(velocity(s, c, p, t)) || 1));
    return rib.section(t - dt, t + dt);
  });
  return { front: rib.section(0, 1), back: twist ? rib.section(TWIST_BACK, 1) : '', rings: ringsD, control: c, rib, twist };
}

/**
 * The bound fold, sampled for CSS keyframes (Astra §3): bow 22° toward the head's side by 20%, then the collar runs
 * back down the neck's own curve (P → Q(u) → S) while the head flattens to scaleY .3, then settles just below the
 * socket at P_b = S + (0.04σH, 0.30·c_y·H + 2q). The neck shortens along the same curve: section(0, u, u).
 */
export function foldFrames(n: NeckShape, headH: number, anchorY: number, sideSign: number): { f: number; dx: number; dy: number; bow: number; sy: number; neck: string }[] {
  const { s, c, p } = n.rib;
  const q = clamp(headH / 100, 0.6, 1.3);
  const sigma = sideSign === 0 ? 1 : Math.sign(sideSign);
  const pb = { x: s.x + 0.04 * sigma * headH, y: s.y + 0.3 * anchorY * headH + 2 * q };
  const out: { f: number; dx: number; dy: number; bow: number; sy: number; neck: string }[] = [];
  for (const f of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1]) {
    let at = p;
    let bow = 0;
    let sy = 1;
    let u = 1;
    if (f <= 0.2) bow = 22 * sigma * smooth(f / 0.2);
    else if (f <= 0.7) {
      const v = smooth((f - 0.2) / 0.5);
      u = 1 - v;
      at = quadAt(s, c, p, u);
      bow = 22 * sigma * (1 - v);
      sy = 1 - 0.7 * v;
    } else {
      const w = smooth((f - 0.7) / 0.3);
      u = 0;
      at = { x: mix(s.x, pb.x, w), y: mix(s.y, pb.y, w) };
      sy = 0.3;
    }
    out.push({ f, dx: r1(at.x - p.x), dy: r1(at.y - p.y), bow: r1(bow), sy: Math.round(sy * 1000) / 1000, neck: u > 0.02 ? n.rib.section(0, u, u) : n.rib.section(0, 0.02, 0.02) });
  }
  return out;
}

/** The folded remnant's resting transform (the last fold frame), for the static bound state. */
export function foldRest(n: NeckShape, headH: number, anchorY: number, sideSign: number): { dx: number; dy: number } {
  const last = foldFrames(n, headH, anchorY, sideSign).at(-1)!;
  return { dx: last.dx, dy: last.dy };
}

/**
 * The drag ribbon's control point: gravity projected perpendicular to the chord, C = mid + g⊥·min(0.22L, 0.15L²/h).
 * The centre line advances strictly along the chord, so the strip never doubles back; a vertical drag is straight.
 */
export function dragControl(from: P, to: P, width = 14): P {
  const d = sub(to, from);
  const L = len(d);
  if (L < 0.25) return mul(add(from, to), 0.5);
  const u = mul(d, 1 / L);
  const gPerp = sub({ x: 0, y: 1 }, mul(u, u.y));
  const sag = Math.min(0.22 * L, (0.15 * L * L) / (width / 2));
  return add(mul(add(from, to), 0.5), mul(gPerp, sag));
}

/** A constant-width paper strip from the card to the pointer (14 px). */
export function dragShape(from: P, to: P, width = 14): string {
  if (len(sub(to, from)) < 0.25) return '';
  return ribbon(from, dragControl(from, to, width), to, width, width, { N: 40 }).section(0, 1);
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
  const strip = document.createElementNS(SVG_NS, 'path');
  strip.setAttribute('fill', '#FFF9EE');
  strip.setAttribute('stroke', '#41291F');
  strip.setAttribute('stroke-width', '1.4');
  strip.setAttribute('stroke-linejoin', 'round');
  svgEl.append(strip);
  return {
    el: svgEl,
    draw(from, to) {
      svgEl.setAttribute('visibility', to ? 'visible' : 'hidden');
      if (!to) return;
      strip.setAttribute('d', dragShape(from, to));
    },
  };
}
