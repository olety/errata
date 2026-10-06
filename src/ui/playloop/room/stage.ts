// Owner: room/rig. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { ControllerApi, RoomView } from '../contract';
import { STAMPS } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/** One complete receipt at a time with a visible queue and immediate advance; the four stamps (§0a.6, §0a.13). */
export function ReceiptStage(p: { room: RoomView; api: ControllerApi }): HTMLElement {
  const r = p.room.receipts.current;
  if (!r) return el('div', 'pl-stage');
  return el(
    'div',
    'pl-stage',
    el('p', 'pl-quote', r.quote ? `“${r.quote}”` : 'Tool evidence only'),
    el('p', 'pl-mono', r.action ?? ''),
    el('p', 'pl-mono', r.result ?? ''),
    p.room.phase === 'judge' ? el('div', '', ...STAMPS.map((s) => {
      const b = el('button', '', s.label);
      b.addEventListener('click', () => p.api.stamp(r.caseId, s.stamp));
      return b;
    })) : null,
    el('small', '', `${p.room.receipts.queue.length} to read`),
  );
}
