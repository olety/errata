// Owner: cards/layout. Presentation maths for the Table: where the painted world plate sits so its table edge lands on
// the shore line, and how the wood extends below it. Pure; numbers here are pixels, never game data.

export interface Plate {
  src: string;
  w: number;
  h: number;
  /** First row of the painted table edge, in plate pixels (measured on the bench). */
  edge: number;
  /** The wood rows reused, alternately mirrored, to extend the table down. */
  band: [number, number];
}

/** The two plates the bench measured (bench/room-v1.html, PLATES). */
export const PLATES = {
  raised: { src: 'layout/world-table.png', w: 1536, h: 1024, edge: 647, band: [664, 1024] },
  portrait: { src: 'layout/world-portrait.png', w: 1024, h: 1536, edge: 888, band: [904, 1536] },
} as const satisfies Record<string, Plate>;

export interface PlatePlacement {
  scale: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Mirrored copies of the wood band stacked under the plate until the table's bottom is covered. */
  ext: { top: number; height: number; flip: boolean; bgTop: number }[];
}

/** Cover the width, land the plate's table edge on shoreY, and extend the wood down to `bottom`. */
export function placePlate(p: Plate, width: number, shoreY: number, bottom: number): PlatePlacement {
  const scale = Math.max(width / p.w, shoreY / p.edge);
  const w = p.w * scale;
  const h = p.h * scale;
  const left = (width - w) / 2;
  const top = shoreY - p.edge * scale;
  const ext: PlatePlacement['ext'] = [];
  const bandH = (p.band[1] - p.band[0]) * scale;
  let y = top + h;
  for (let i = 0; y < bottom && i < 12 && bandH > 0; i++) {
    // A flipped copy shows the band's last rows at its top, so every seam meets itself even when the copy is cut short.
    const flip = i % 2 === 0;
    const height = Math.ceil(Math.min(bandH, bottom - y)) + 1;
    ext.push({ top: Math.floor(y), height, flip, bgTop: flip ? -(p.band[1] * scale - height) : -p.band[0] * scale });
    y += bandH;
  }
  return { scale, left, top, width: w, height: h, ext };
}
