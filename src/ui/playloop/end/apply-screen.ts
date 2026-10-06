// Owner: boss/apply. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { ApplyView, ScreenProps } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/**
 * Apply (§9): both diffs, the blockers with "Return to the final campfire", the seal, three stamps that ink only as
 * each verifies, Undo. Presentation only: the write protocol is the engine's, reached through api.apply.
 */
export function ApplyScreen(p: ScreenProps<ApplyView>): { stage: HTMLElement; wood: HTMLElement } {
  const v = p.view;
  const stage = el(
    'section',
    'pl-apply',
    ...v.blockers.map((b) => el('p', 'pl-blocker', b.text)),
    ...v.diffs.map((d) => el('pre', '', `${d.path}\n${d.ops.filter((o) => o.op !== 'same').map((o) => (o.op === 'add' ? '+ ' : '− ') + o.line).join('\n')}`)),
    el('p', '', `Reviewed ${v.stamps.reviewed} · Fits ${v.stamps.fits} · Written ${v.stamps.written}`),
    el('footer', '', v.footer),
  );
  const seal = el('button', '', 'Seal');
  seal.toggleAttribute('disabled', !v.canSeal);
  seal.addEventListener('click', () => void p.api.apply.seal());
  return { stage, wood: el('div', 'pl-wood', seal) };
}
