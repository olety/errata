// Owner: boss/apply. Art for the boss lake and Apply, copied unchanged from the Yard #4 plates into public/playloop/end/.
// The boss is the run's largest family skin grown huge (§4, §9). BossView carries no skin yet, so every boss uses the
// Suite Wyrm plates. TODO(contract ask): BossView.skin; then point body/head at public/playloop/beasts/<skin>/ once the
// room/rig worker's art is merged, and drop the copies here.

import type { Skin } from '../contract';

const base = import.meta.env.BASE_URL;
const at = (f: string) => `${base}playloop/end/${f}`;

export const ART = {
  /** The raised world plate: sky, lake and wood (1536 × 1024). The boss tints it to blue hour. */
  plate: at('world-table.png'),
  body(_skin: Skin | null): string {
    return at('boss-body-wyrm.png');
  },
  head(_skin: Skin | null): string {
    return at('boss-head-wyrm.png');
  },
};
