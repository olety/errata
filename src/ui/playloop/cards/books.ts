// Owner: cards/layout. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { BookView, DragPreview, DropBinder } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export interface BooksProps {
  books: BookView[];
  /** The live drag preview: the strap ghost per lane and the exact line typeset on the open page. */
  preview: DragPreview | null;
  /** Room: a drop plays into that file. Campfire: a drop re-targets a card already in the proposal. */
  mode: 'play' | 'retarget';
  /** Props on the wood, or two 44 px tabs on phones (bands.books.mode). */
  layout: 'props' | 'tabs';
  drag: DropBinder;
}

/** CLAUDE.md and AGENTS.md as books with leather strap meters and the Proposed watermark (§1, §5, §0a.1). */
export function Books(p: BooksProps): HTMLElement {
  return el(
    'div',
    `pl-books pl-books-${p.layout}`,
    ...p.books.map((b) => {
      const node = el('div', 'pl-book', el('b', '', b.file), el('small', '', `${b.weight.now} / ${b.weight.allowance} estimated`), b.proposed ? el('small', '', 'Proposed') : null);
      p.drag.bindTarget(`book:${b.lane}`, p.mode === 'play' ? { kind: 'book', lane: b.lane } : { kind: 'book-retarget', lane: b.lane }, node);
      return node;
    }),
  );
}
