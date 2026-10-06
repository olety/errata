// Owner: boss/apply. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { BossView, ScreenProps } from '../contract';
import { STAMPS } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/**
 * The boss (§9, §0a.12): sealed heads rise oldest first; the receipt is readable before the blind stamp; then the
 * answer drag (glowing deck cards) or Continue; the earlier Open pages rise after; the score locks with set-asides.
 */
export function BossScreen(p: ScreenProps<BossView>): { stage: HTMLElement; wood: HTMLElement } {
  const v = p.view;
  const cur = v.heads.find((h) => h.caseId === v.current);
  const head = el('div', 'pl-boss-head', cur ? cur.receipt.quote ?? 'Tool evidence only' : 'Every later case has faced the final deck.');
  if (cur) p.drag.bindTarget(`boss:${cur.caseId}`, { kind: 'head', caseId: cur.caseId }, head);
  const next = el('button', '', v.current ? 'Continue' : 'Go to Apply');
  next.addEventListener('click', () => (v.current ? p.api.boss.next() : p.api.advance()));
  const stage = el(
    'section',
    'pl-boss',
    head,
    cur && cur.disposition === 'unreviewed' && cur.source === 'sealed' ? el('div', '', ...STAMPS.map((s) => {
      const b = el('button', '', s.label);
      b.addEventListener('click', () => p.api.boss.stamp(cur.caseId, s.stamp));
      return b;
    })) : null,
    v.noEligibleCard ? el('p', '', 'No eligible card') : null,
    ...v.score.lines.map((l) => el('p', '', l)),
    next,
  );
  // The wood holds the deck's books, where eligible cards glow for the answer drag (the mount passes none in P0).
  return { stage, wood: el('div', 'pl-wood') };
}
