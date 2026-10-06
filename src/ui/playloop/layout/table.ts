// Owner: cards/layout. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { Bands } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export interface TableProps {
  bands: Bands;
  header: HTMLElement;
  /** The creature stage (sky + creature), or the campfire's focused pair, or the boss lake. */
  stage: HTMLElement;
  wood: HTMLElement;
  status: HTMLElement;
}

/** The Table layout: header, stage, wood and status bands at the heights layout() computed (§1, §0a.17). */
export function Table(p: TableProps): HTMLElement {
  const root = el('div', 'pl-table', p.header, p.stage, p.wood, p.status);
  root.style.minHeight = `${p.bands.viewport.h}px`;
  return root;
}
