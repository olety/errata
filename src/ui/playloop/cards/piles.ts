// Owner: cards/layout. The shelf and the Open pile (play-loop §6, §0a.7, §0a.18): props on the wood, or one shared
// 44 px rail on phones. The shelf is a drop target (skip) only when the room says so; Open is a list, never a target.
// Counts come from the view (shelfCount, openCount). Import from ../contract only.
import type { ControllerApi, DropBinder, PilesView } from '../contract';
import { AGENT_NAME } from '../contract';
import { button, el, inline, Sigil } from './dom';
import './cards.css';

export interface PilesProps {
  piles: PilesView;
  /** Props on the wood, or one shared 44 px rail on phones (bands.piles.mode). */
  layout: 'props' | 'rail';
  /** The shelf is a drop target (skip) in rooms; Open is never a drop target. */
  shelfTarget: boolean;
  api: ControllerApi;
  drag: DropBinder;
}

/** Which pile's list is fanned open; presentation memory across repaints, never game state. */
let fanned: 'shelf' | 'open' | null = null;

/** The shelf (discard) and the Open pile (torn pages, a set keyed by case id). */
export function Piles(p: PilesProps): HTMLElement {
  const v = p.piles;
  const root = el('div', `pl-cards-piles pl-cards-piles-${p.layout}`);

  // The shelf: face up, a slight cascade, the count on its edge. Nothing on it is ever written.
  const shelf = el(
    'div',
    `pl-cards-pile pl-cards-shelf${p.shelfTarget ? ' is-target' : ''}`,
    p.layout === 'props' ? Stack(v.shelfCount, 'paper') : null,
    el('span', 'pl-cards-pile-name', 'Shelf'),
    el('b', 'pl-cards-pile-count pl-cards-mono', String(v.shelfCount)),
    p.layout === 'props' ? el('span', 'pl-cards-pile-hint', p.shelfTarget ? 'Drop here to skip. Never written.' : 'Never written.') : null,
  );
  shelf.setAttribute('aria-label', `Shelf: ${v.shelfCount} cards, never written${p.shelfTarget ? '. Drop a card here to skip' : ''}`);
  if (p.shelfTarget) p.drag.bindTarget('shelf', { kind: 'shelf' }, shelf);

  // The Open pile: torn pages, one per confirmed case the proposal does not address. A list to read, never a target.
  const open = el(
    'div',
    'pl-cards-pile pl-cards-open',
    p.layout === 'props' ? Stack(v.openCount, 'torn') : null,
    el('span', 'pl-cards-pile-name', 'Open'),
    el('b', 'pl-cards-pile-count pl-cards-mono', String(v.openCount)),
    p.layout === 'props' ? el('span', 'pl-cards-pile-hint', 'Confirmed cases no card answers yet.') : null,
  );
  open.setAttribute('aria-label', `Open pile: ${v.openCount} confirmed cases without a covering card`);

  const toggle = (which: 'shelf' | 'open', host: HTMLElement, list: () => HTMLElement) => {
    const b = button('pl-cards-fan', fanned === which ? 'Close' : 'List', () => {
      fanned = fanned === which ? null : which;
      host.querySelector('.pl-cards-fanlist')?.remove();
      b.textContent = fanned === which ? 'Close' : 'List';
      b.setAttribute('aria-expanded', String(fanned === which));
      if (fanned === which) host.append(list());
    });
    b.setAttribute('aria-expanded', String(fanned === which));
    b.setAttribute('aria-label', which === 'shelf' ? 'List the shelf' : 'List the open pages');
    return b;
  };
  const shelfList = () =>
    el(
      'ol',
      'pl-cards-fanlist',
      ...v.shelf.map((c) => el('li', '', button('pl-cards-fanitem', el('span', '', el('b', '', c.face.title), ' · ', ...inline(c.face.summary)), () => p.api.inspect({ cardId: c.id }), `Inspect ${c.face.title}`))),
    );
  const openList = () =>
    el(
      'ol',
      'pl-cards-fanlist',
      ...v.open.map((o) =>
        el(
          'li',
          '',
          button('pl-cards-fanitem', el('span', '', Sigil(o.tag.agent, true), ` ${AGENT_NAME[o.tag.agent]}`, o.tag.project ? ` · ${o.tag.project}` : '', ' · ', el('span', 'pl-cards-mono', o.tag.date ?? 'no date'), el('span', 'pl-cards-fanquote', o.receipt.quote ?? 'Tool evidence only')), () => p.api.inspect({ caseId: o.caseId }), 'Read this open case'),
        ),
      ),
    );
  // The list toggles sit beside the piles, outside the shelf's target box, so a tap on "List" never skips.
  const shelfWrap = el('div', 'pl-cards-pilewrap', shelf);
  const openWrap = el('div', 'pl-cards-pilewrap', open);
  if (v.shelf[0] !== undefined) shelfWrap.append(toggle('shelf', shelfWrap, shelfList));
  if (v.open[0] !== undefined) openWrap.append(toggle('open', openWrap, openList));
  if (fanned === 'shelf' && v.shelf[0] !== undefined) shelfWrap.append(shelfList());
  if (fanned === 'open' && v.open[0] !== undefined) openWrap.append(openList());
  root.append(shelfWrap, openWrap);
  return root;
}

/** A small cascade: paper slips for the shelf, torn pages for Open. Decoration; the count is the view's. */
function Stack(count: number, kind: 'paper' | 'torn'): HTMLElement {
  const s = el('span', `pl-cards-stack is-${kind}${count > 0 ? '' : ' is-empty'}`, el('i', ''), el('i', ''), el('i', ''));
  s.setAttribute('aria-hidden', 'true');
  return s;
}
