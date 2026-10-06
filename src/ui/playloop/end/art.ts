// Owner: boss/apply. Art for the boss lake and Apply. The boss is the run's largest family skin grown huge (§4, §9):
// its body and head are that skin's room plates (BossView.skin); the lake is the Table's raised world plate.

import type { Skin } from '../contract';

const base = import.meta.env.BASE_URL;
const at = (f: string) => `${base}playloop/${f}`;
/** The boss never wears the Workshop owl or the Event heron: those skins fall back to the Suite Wyrm. */
const bossSkin = (s: Skin | null): Skin => (s && s !== 'owl' && s !== 'heron' ? s : 'suite-wyrm');

export const ART = {
  /** The raised world plate: sky, lake and wood (1536 × 1024). The boss tints it to blue hour. */
  plate: at('layout/world-table.webp'),
  body(skin: Skin | null): string {
    return at(`beasts/${bossSkin(skin)}/body.webp`);
  },
  head(skin: Skin | null): string {
    return at(`beasts/${bossSkin(skin)}/head.webp`);
  },
};
