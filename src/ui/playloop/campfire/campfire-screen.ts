// Owner: campfire. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { CampfireView, ChangePreviewView, ScreenProps } from '../contract';
import { Books, Card, Piles } from '../cards';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/**
 * The campfire (§7, §0a.21): lane tabs (Claude / both / Codex) and one focused pair, gold and red threads with their
 * reasons, stack to propose and seal to perform (ui.pending), the fire to cut, the books to re-target, the ash list to
 * restore. Returns the stage band (focused pair, threads, seal preview) and the wood band (lane cards, fire, books, piles).
 */
export function CampfireScreen(p: ScreenProps<CampfireView>): { stage: HTMLElement; wood: HTMLElement } {
  const v = p.view;
  const fire = el('div', 'pl-fire', 'The fire');
  p.drag.bindTarget('fire', { kind: 'fire' }, fire);
  const tabs = el('nav', '', ...(['claude', 'both', 'codex'] as const).map((t) => {
    const b = el('button', t === v.tab ? 'is-on' : '', t);
    b.addEventListener('click', () => p.api.campfire.tab(t));
    return b;
  }));
  const lane = el('div', 'pl-lane', ...v.lanes[v.tab].map((c) => {
    const node = Card({ card: c, size: 'M', selected: p.ui.selected === c.id, drag: p.drag, onInspect: (id) => p.api.inspect({ cardId: id }) });
    p.drag.bindTarget(`card:${c.id}`, { kind: 'card', cardId: c.id }, node);
    return node;
  }));
  const leave = el('button', '', 'Leave the campfire');
  leave.addEventListener('click', () => p.api.advance());
  return {
    stage: el('section', 'pl-campfire', v.coach ? el('p', '', v.coach) : null, el('ul', '', ...v.threads.map((t) => el('li', `pl-thread-${t.color}`, t.reason))), leave),
    wood: el('div', 'pl-wood', tabs, lane, fire, Books({ books: v.books, preview: p.ui.drag?.preview ?? null, mode: 'retarget', layout: p.ui.bands.books.mode, drag: p.drag }), Piles({ piles: v.piles, layout: p.ui.bands.piles.mode, shelfTarget: false, api: p.api, drag: p.drag })),
  };
}

/** The seal preview for a pending stack, settlement, cut, swap or re-target, read from ui.pending. */
export function SealPreview(p: { preview: ChangePreviewView | null }): HTMLElement {
  return el('div', 'pl-seal', p.preview ? p.preview.cases.text : '');
}
