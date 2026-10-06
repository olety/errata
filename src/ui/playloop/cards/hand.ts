// Owner: cards/layout. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { Bands, CardView, ControllerApi, DropBinder, UiView } from '../contract';
import { Card } from './card';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export interface HandProps {
  cards: CardView[];
  bands: Bands;
  ui: UiView;
  api: ControllerApi;
  drag: DropBinder;
}

/** The dealt hand: a fan when the wood allows, flat when tight, a snapping carousel on phones (bands.fan). */
export function Hand(p: HandProps): HTMLElement {
  return el('div', `pl-hand pl-hand-${p.bands.fan}`, ...p.cards.map((c) => Card({ card: c, size: p.bands.card.size, selected: p.ui.selected === c.id, drag: p.drag, onInspect: (id) => p.api.inspect({ cardId: id }) })));
}
