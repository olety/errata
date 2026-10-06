// Owner: room/rig. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { BeastView, DropBinder, HeadGlow, UiView } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export interface BeastProps {
  beast: BeastView;
  /** Per-head glow and one word while dragging (from ui.drag.preview.heads). */
  glow: ReadonlyMap<string, HeadGlow>;
  beat: UiView['beat'];
  reducedMotion: boolean;
  /** The creature band's height; the feet stand on its bottom edge (bands.shoreY). */
  height: number;
  drag: DropBinder;
  onHead(caseId: string): void;
}

/** The beast: body plate, heads in sockets with tags and rings, the "+N" knot, pips (§4, §0a.22). */
export function Beast(p: BeastProps): HTMLElement {
  const root = el('div', 'pl-beast', el('b', '', p.beast.name), el('small', '', p.beast.pips.text));
  p.drag.bindTarget('beast', { kind: 'beast' }, root);
  for (const h of p.beast.heads) {
    const g = p.glow.get(h.caseId);
    const head = el('button', `pl-head is-${h.state}${g?.glow ? ' is-glow' : ''}`, `${h.tag.agent} ${h.tag.date ?? ''}`, g?.word ? el('small', '', g.word) : null);
    head.addEventListener('click', () => p.onHead(h.caseId));
    p.drag.bindTarget(`head:${h.caseId}`, { kind: 'head', caseId: h.caseId }, head);
    root.append(head);
  }
  if (p.beast.overflow) root.append(el('small', '', p.beast.overflow.text));
  return root;
}
