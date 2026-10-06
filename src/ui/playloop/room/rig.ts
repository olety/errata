// Owner: room/rig. One shared 2D paper puppet for every skin (§0a.22): a body plate, one head sprite per skin at a
// fixed scale, five sockets and head points in normalized rig space, SVG necks masked behind the body, one shared
// ground shadow. Skins differ only in data. Size, pose and skin encode nothing (§13, "not data").
//
// Coordinates: x in body-plate widths, y in body-plate heights, origin at the plate's top-left; y < 0 is above the
// plate. The collars were measured from the plates' alpha channel by measure-rig.py beside this file: a collar is a
// peak of the top silhouette, its opening the centroid of the darker interior paint inside the collar box. Head anchors
// are the head sprites' collar openings, found the same way along the bottom silhouette.
import type { Skin } from '../contract';

export type Pt = readonly [number, number];

export interface Rig {
  skin: Skin;
  /** Body plate, relative to the page (public/playloop/beasts/<skin>/body.webp); null when the head is the whole beast. */
  body: string | null;
  /** Head sprite (head.webp); null when heads are drawn (the Workshop's lanterns). */
  head: string | null;
  /** Body plate size in px (its aspect matters; for a bodiless rig, the virtual box the head stands in). */
  plate: { w: number; h: number };
  /** Head sprite size in px (aspect). */
  headPlate: { w: number; h: number };
  /** Opaque box of the body plate (normalized): the feet stand on y1. */
  bodyBox: { x0: number; y0: number; x1: number; y1: number };
  /** Measured collar openings on the body plate: centre and width (plate widths). */
  collars: readonly { at: Pt; w: number }[];
  /** Five neck sockets, normalized. Several may share one collar, offset across its width. */
  sockets: readonly Pt[];
  /** Neck width at each socket, in plate widths (derived from the collars it shares). */
  neckW: readonly number[];
  /** Where each head's anchor sits (the head point), normalized; x order matches the sockets' x order. */
  heads: readonly Pt[];
  /** Where a head sprite attaches to its neck (its collar opening), normalized to the head sprite. */
  headAnchor: Pt;
  /** The head collar's width, in head-sprite widths (the neck's top width). */
  headCollarW: number;
  /** Head sprite height in body-plate heights (one fixed scale per skin). */
  headScale: number;
  /** Necks: paper ribbons, or the lanterns' strings. */
  neck: 'ribbon' | 'string' | 'none';
  /** Share of the creature band the whole rig may use (the heron stands lower). */
  fill: number;
}

/** WebP plates, about twice their largest drawn size (P2: 37 MB of PNG became 1.4 MB; the originals live outside the repo). */
const url = (skin: Skin, part: 'body' | 'head') => `playloop/beasts/${skin}/${part}.webp`;

/** Five sockets from collars: [collar index, offset across the collar in collar widths], in socket order. */
function socketsOn(collars: readonly { at: Pt; w: number }[], plan: readonly [number, number][]): Pt[] {
  return plan.map(([c, off]) => {
    const k = collars[c]!;
    return [round(k.at[0] + off * k.w), k.at[1]] as const;
  });
}

/** Neck width at each socket (Astra): 0.65 of the collar when it is the collar's only neck, 0.3 when necks share it. */
function neckWidths(collars: readonly { at: Pt; w: number }[], plan: readonly [number, number][]): number[] {
  return plan.map(([c]) => round(collars[c]!.w * (plan.filter(([x]) => x === c).length > 1 ? 0.3 : 0.65)));
}

// Socket allocation (Astra, astra-neck §5): the x order of sockets and head points is always 3, 1, 0, 2, 4.
const ONE_EACH: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
const WYRM_PLAN: [number, number][] = [[0, 0], [0, -0.16], [1, 0], [0, -0.32], [2, 0]];
const ONE_COLLAR: [number, number][] = [[0, 0], [0, -0.16], [0, 0.16], [0, -0.32], [0, 0.32]];
// P3 (Astra, astra-rig five heads): one collar carrying a three-over-two crown spreads its sockets wider, so the
// outer necks leave the collar on their own side.
const CROWN_PLAN: [number, number][] = [[0, 0], [0, -0.24], [0, 0.24], [0, -0.46], [0, 0.46]];

const round = (n: number) => Math.round(n * 10000) / 10000;

// Measured (measure-rig.py, 2026-10-07): collar openings and widths, head anchors, opaque boxes.
const WYRM_COLLARS = [
  { at: [0.4276, 0.0453], w: 0.1555 },
  { at: [0.5703, 0.226], w: 0.1067 },
  { at: [0.7674, 0.3311], w: 0.1059 },
] as const;
const HYDRA_COLLARS = [
  { at: [0.4901, 0.0528], w: 0.147 },
  { at: [0.2679, 0.1083], w: 0.1295 },
  { at: [0.7091, 0.1022], w: 0.1303 },
  { at: [0.0855, 0.1674], w: 0.1084 },
  { at: [0.9002, 0.1639], w: 0.1114 },
] as const;
const STAG_COLLARS = [{ at: [0.2, 0.0492], w: 0.1266 }] as const;
const MOTH_COLLARS = [{ at: [0.4989, 0.2693], w: 0.1055 }] as const;

export const RIGS: Record<Skin, Rig> = {
  'suite-wyrm': {
    skin: 'suite-wyrm',
    body: url('suite-wyrm', 'body'),
    head: url('suite-wyrm', 'head'),
    plate: { w: 1312, h: 1199 },
    headPlate: { w: 1225, h: 1284 },
    bodyBox: { x0: 0.0084, y0: 0.005, x1: 0.9909, y1: 0.995 },
    collars: WYRM_COLLARS,
    // Three collars, five necks: the tall front collar carries the anchor and two more.
    sockets: socketsOn(WYRM_COLLARS, WYRM_PLAN),
    neckW: neckWidths(WYRM_COLLARS, WYRM_PLAN),
    heads: [[0.47, -0.17], [0.15, -0.08], [0.8, 0.02], [-0.17, 0.0], [1.12, 0.2]],
    headAnchor: [0.6452, 0.9097],
    headCollarW: 0.32,
    headScale: 0.4,
    neck: 'ribbon',
    fill: 1,
  },
  'retry-hydra': {
    skin: 'retry-hydra',
    body: url('retry-hydra', 'body'),
    head: url('retry-hydra', 'head'),
    plate: { w: 1374, h: 1145 },
    headPlate: { w: 1226, h: 1283 },
    bodyBox: { x0: 0.0066, y0: 0.0079, x1: 0.9927, y1: 0.9886 },
    collars: HYDRA_COLLARS,
    // One neck per collar: the tall centre collar is the anchor.
    sockets: socketsOn(HYDRA_COLLARS, ONE_EACH),
    neckW: neckWidths(HYDRA_COLLARS, ONE_EACH),
    heads: [[0.49, -0.15], [0.18, -0.09], [0.8, -0.09], [-0.13, -0.01], [1.11, -0.01]],
    headAnchor: [0.5371, 0.8881],
    headCollarW: 0.2814,
    headScale: 0.42,
    neck: 'ribbon',
    fill: 1,
  },
  'boundary-stag': {
    skin: 'boundary-stag',
    body: url('boundary-stag', 'body'),
    head: url('boundary-stag', 'head'),
    plate: { w: 1374, h: 1145 },
    headPlate: { w: 1246, h: 1262 },
    bodyBox: { x0: 0.1281, y0: 0.0044, x1: 0.9622, y1: 0.9956 },
    collars: STAG_COLLARS,
    // One collar, five necks in a three-over-two crown over the stag's neck (P3, Astra): the outer pair sits about
    // 1.2 head-heights from the collar, not strung out sideways on long flat necks.
    sockets: socketsOn(STAG_COLLARS, CROWN_PLAN),
    neckW: neckWidths(STAG_COLLARS, CROWN_PLAN),
    heads: [[0.2, -0.45], [-0.048, -0.43], [0.448, -0.43], [-0.065, -0.125], [0.465, -0.125]],
    headAnchor: [0.5818, 0.927],
    headCollarW: 0.2632,
    headScale: 0.3,
    neck: 'ribbon',
    fill: 1,
  },
  'patch-moth': {
    skin: 'patch-moth',
    body: url('patch-moth', 'body'),
    head: url('patch-moth', 'head'),
    plate: { w: 1536, h: 1024 },
    headPlate: { w: 1374, h: 1145 },
    bodyBox: { x0: 0.0111, y0: 0.0371, x1: 0.9889, y1: 0.9463 },
    collars: MOTH_COLLARS,
    // Five heads above the wings in a three-over-two crown (P3, Astra), never beyond the wingtips.
    sockets: socketsOn(MOTH_COLLARS, CROWN_PLAN),
    neckW: neckWidths(MOTH_COLLARS, CROWN_PLAN),
    heads: [[0.4989, -0.39], [0.2539, -0.365], [0.7439, -0.365], [0.2489, 0.0], [0.7489, 0.0]],
    headAnchor: [0.499, 0.9035],
    headCollarW: 0.1783,
    headScale: 0.36,
    neck: 'ribbon',
    fill: 1,
  },
  // The Workshop: no beast. An owl at a bench; one paper lantern per verified session hangs on a string (§4).
  owl: {
    skin: 'owl',
    body: url('owl', 'body'),
    head: null,
    plate: { w: 1199, h: 1312 },
    headPlate: { w: 62, h: 100 },
    bodyBox: { x0: 0.1776, y0: 0.0053, x1: 0.8891, y1: 0.9924 },
    collars: [],
    // Lanterns hang on strings left and right of the owl, clear of its face; strings never cross.
    sockets: [[-0.12, -0.06], [1.12, -0.06], [-0.36, -0.06], [1.36, -0.06], [-0.6, -0.06]],
    neckW: [0.004, 0.004, 0.004, 0.004, 0.004],
    heads: [[-0.12, 0.1], [1.12, 0.14], [-0.36, 0.3], [1.36, 0.34], [-0.6, 0.12]],
    headAnchor: [0.5, 0.0],
    headCollarW: 0.04,
    headScale: 0.22,
    neck: 'string',
    fill: 1,
  },
  // The Event: the heron is the whole beast and its one head (§8). Stamped a problem, it stays the one-head room.
  heron: {
    skin: 'heron',
    body: null,
    head: url('heron', 'head'),
    plate: { w: 1536, h: 1024 },
    headPlate: { w: 1536, h: 1024 },
    bodyBox: { x0: 0.0202, y0: 0.0078, x1: 0.9727, y1: 1 },
    collars: [],
    sockets: [[0.5, 1]],
    neckW: [0],
    heads: [[0.5, 1]],
    headAnchor: [0.5, 0.98],
    headCollarW: 0,
    headScale: 1,
    neck: 'none',
    fill: 0.82,
  },
};

// ------------------------------------------------------------------ fitting a rig into the creature band (pure)

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HeadPlace {
  socket: number;
  /** The head sprite's box in beast px. */
  box: Rect;
  /** The head point: where the head's collar sits. */
  at: { x: number; y: number };
  /** The neck's socket on the body. */
  from: { x: number; y: number };
  /** Neck width at the socket and at the head. */
  w0: number;
  w1: number;
}

export interface RigPlace {
  /** The beast's box: body and the heads in use, feet on its bottom edge. */
  w: number;
  h: number;
  /** One body-plate height in px. */
  scale: number;
  body: Rect | null;
  heads: HeadPlace[];
  /** The shared ground shadow under the feet. */
  shadow: Rect;
}

/** The head sprite box for socket i at plate height Hp (origin at the plate's top-left). */
function headBox(rig: Rig, i: number, Hp: number): { box: Rect; at: { x: number; y: number } } {
  const Wp = Hp * (rig.plate.w / rig.plate.h);
  const p = rig.heads[i]!;
  const hh = rig.headScale * Hp;
  const hw = hh * (rig.headPlate.w / rig.headPlate.h);
  const at = { x: p[0] * Wp, y: p[1] * Hp };
  return { box: { x: at.x - rig.headAnchor[0] * hw, y: at.y - rig.headAnchor[1] * hh, w: hw, h: hh }, at };
}

/**
 * Fit the rig into a box `maxH` tall (and `maxW` wide, when given): the body plate and the heads in `sockets`, with the
 * feet on the bottom edge. Presentation maths only; the beast's numbers come from the view.
 */
export function fitRig(rig: Rig, sockets: readonly number[], maxH: number, maxW = Infinity): RigPlace {
  const used = sockets.filter((s) => s >= 0 && s < rig.heads.length);
  // Bounding box at Hp = 1.
  let x0 = rig.body ? rig.bodyBox.x0 * (rig.plate.w / rig.plate.h) : Infinity;
  let x1 = rig.body ? rig.bodyBox.x1 * (rig.plate.w / rig.plate.h) : -Infinity;
  let y0 = rig.body ? rig.bodyBox.y0 : Infinity;
  const y1 = rig.bodyBox.y1;
  for (const s of used) {
    const { box } = headBox(rig, s, 1);
    x0 = Math.min(x0, box.x);
    x1 = Math.max(x1, box.x + box.w);
    y0 = Math.min(y0, box.y, rig.neck === 'string' ? rig.sockets[s]![1] : Infinity);
  }
  if (!Number.isFinite(x0)) {
    x0 = 0;
    x1 = rig.plate.w / rig.plate.h;
    y0 = 0;
  }
  const unitsH = y1 - y0;
  const unitsW = x1 - x0;
  const Hp = Math.max(1, Math.min((maxH * rig.fill) / unitsH, maxW / unitsW));
  const Wp = Hp * (rig.plate.w / rig.plate.h);
  const w = Math.round(unitsW * Hp);
  const h = Math.round(unitsH * Hp);
  // Shift so the box's top-left is (0, 0): plate origin at (-x0·Hp, -y0·Hp).
  const ox = -x0 * Hp;
  const oy = -y0 * Hp;
  const body = rig.body ? { x: ox, y: oy, w: Wp, h: Hp } : null;
  const heads = used.map((s) => {
    const { box, at } = headBox(rig, s, Hp);
    const sk = rig.sockets[s]!;
    return {
      socket: s,
      box: { x: box.x + ox, y: box.y + oy, w: box.w, h: box.h },
      at: { x: at.x + ox, y: at.y + oy },
      from: { x: sk[0] * Wp + ox, y: sk[1] * Hp + oy },
      w0: Math.max(1.5, rig.neckW[s]! * Wp),
      w1: Math.max(1.5, rig.headCollarW * box.w * 0.7),
    };
  });
  const bw = rig.body ? (rig.bodyBox.x1 - rig.bodyBox.x0) * Wp : (heads[0]?.box.w ?? w) * 0.7;
  const bx = rig.body ? ox + rig.bodyBox.x0 * Wp : (heads[0] ? heads[0].at.x - bw / 2 : 0);
  const shadow = { x: bx + bw * 0.08, y: h - Math.max(6, Hp * 0.04), w: bw * 0.84, h: Math.max(10, Hp * 0.07) };
  return { w, h, scale: Hp, body, heads, shadow };
}
