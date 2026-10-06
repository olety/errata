// Owner: room/rig. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { Skin } from '../contract';

/**
 * One shared 2D paper puppet (§0a.22): a headless body plate per skin, one head sprite per skin at a fixed scale, five
 * sockets and head anchors in normalized rig space (0–1 of the plate), SVG ribbons masked behind the body.
 * Assets live in public/playloop/beasts/<skin>/ (body.png, head.png); the art source is plates/rig/.
 */
export interface Rig {
  skin: Skin;
  body: string;
  head: string;
  /** Five neck sockets on the body plate, normalized. */
  sockets: readonly [number, number][];
  /** Where a head sprite attaches to its neck, normalized to the head sprite. */
  headAnchor: [number, number];
  /** Head sprite height as a fraction of the creature band. */
  headScale: number;
}

const base = (skin: Skin): Rig => ({ skin, body: `playloop/beasts/${skin}/body.png`, head: `playloop/beasts/${skin}/head.png`, sockets: [[0.3, 0.3], [0.4, 0.22], [0.5, 0.18], [0.6, 0.22], [0.7, 0.3]], headAnchor: [0.5, 0.9], headScale: 0.22 });

/** P0 placeholders: the room/rig worker measures the real plates and replaces these numbers. */
export const RIGS: Record<Skin, Rig> = {
  'suite-wyrm': base('suite-wyrm'),
  'retry-hydra': base('retry-hydra'),
  'boundary-stag': base('boundary-stag'),
  'patch-moth': base('patch-moth'),
  owl: base('owl'),
  heron: base('heron'),
};
