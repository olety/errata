// Owner: room/rig. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { RoomView, ScreenProps } from '../contract';
import { Beast } from './beast';
import { ReceiptStage } from './stage';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/**
 * The room's stage (§2): the beast, one receipt at a time with the stamps, and the room controls (Deal, Pull the hand
 * back, Continue or Keep existing, "Already in your file?"). The mount puts it in the Table's stage band and builds the
 * wood from the cards worker's Hand, Books and Piles. Rise → Judge → Deal → Play → Strike → Clear come from ui.beat.
 */
export function RoomScreen(p: ScreenProps<RoomView>): HTMLElement {
  const v = p.view;
  const glow = new Map((p.ui.drag?.preview?.heads ?? []).map((h) => [h.caseId, h]));
  const button = (label: string, f: () => void) => {
    const b = el('button', '', label);
    b.addEventListener('click', f);
    return b;
  };
  return el(
    'section',
    'pl-room',
    Beast({ beast: v.beast, glow, beat: p.ui.beat, reducedMotion: p.ui.reducedMotion, height: p.ui.bands.creature.h, drag: p.drag, onHead: (id) => p.api.focusReceipt(id) }),
    ReceiptStage({ room: v, api: p.api }),
    el(
      'div',
      'pl-controls',
      v.canDeal ? button('Deal', () => p.api.deal()) : null,
      v.phase === 'dealt' ? button('Pull the hand back', () => p.api.pullBack()) : null,
      v.phase === 'done' || v.offer || v.kind === 'event' ? button(v.offer === 'keep-existing' ? 'Keep existing' : 'Continue', () => p.api.advance()) : null,
      v.finalizes ? el('small', '', v.finalizes) : null,
    ),
  );
}

/** The Event (§8): a heron on the shore with its slip; A change of plan or A problem. */
export function EventScreen(p: ScreenProps<RoomView>): HTMLElement {
  return RoomScreen(p);
}
