// Owner: cards/layout. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { ControllerApi, DropBinder, PilesView } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export interface PilesProps {
  piles: PilesView;
  /** Props on the wood, or one shared 44 px rail on phones (bands.piles.mode). */
  layout: 'props' | 'rail';
  /** The shelf is a drop target (skip) in rooms; Open is never a drop target. */
  shelfTarget: boolean;
  api: ControllerApi;
  drag: DropBinder;
}

/** The shelf (discard) and the Open pile (torn pages, a set keyed by case id). */
export function Piles(p: PilesProps): HTMLElement {
  const shelf = el('div', 'pl-shelf', `Shelf · ${p.piles.shelf.length}`);
  if (p.shelfTarget) p.drag.bindTarget('shelf', { kind: 'shelf' }, shelf);
  return el('div', `pl-piles pl-piles-${p.layout}`, shelf, el('div', 'pl-open', `Open · ${p.piles.open.length}`));
}
