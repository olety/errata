// Owner: cards/layout. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { CardView, DropBinder } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export interface CardProps {
  card: CardView;
  /** M is the default and the minimum reading size at every width ≥ 600 (§0a.18). */
  size: 'S' | 'M' | 'L';
  selected: boolean;
  /** Draggable when a binder is given (hand, deck at the fire, shelf at the fire). */
  drag: DropBinder | null;
  /** Long-press, right-click, F or the external 44 px Inspect control. */
  onInspect(cardId: string): void;
}

/** The one card box (§10): top band, art window, title, summary, footer. No verbs, no buttons on the face. */
export function Card(p: CardProps): HTMLElement {
  const c = p.card;
  const root = el('div', `pl-card pl-card-${p.size}${p.selected ? ' is-selected' : ''}`, el('b', '', c.face.title), el('div', '', c.face.summary), c.face.mark && el('small', '', c.face.mark), c.footer && el('small', '', c.footer.text));
  root.dataset.card = c.id;
  p.drag?.bindCard(c.id, root);
  return root;
}
