// Owner: cards/layout. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { CardView, ControllerApi, ReceiptView } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export interface InspectorProps {
  card: CardView | null;
  receipt: ReceiptView | null;
  /** On phones the inspector replaces the stage or opens as a sheet (§0a.15). */
  layout: 'side' | 'sheet' | 'stage';
  api: ControllerApi;
}

/** The one inspector: full text, receipts, mapping approval and editing (§0a.15). */
export function Inspector(p: InspectorProps): HTMLElement {
  return el('aside', 'pl-inspector', p.card ? el('pre', '', p.card.inspector.exact) : null, p.receipt ? el('p', '', p.receipt.quote ?? 'Tool evidence only') : null);
}
