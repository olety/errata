// Owner: room/rig. Tiny DOM helpers. Strings from logs are always text nodes, never HTML (CONTRACT.md rule 7);
// inline code arrives as backtick spans and becomes <code> elements built with textContent.

import type { Agent } from '../contract';
import { AGENT_NAME } from '../contract';

export type Kid = Node | string | null | false | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: (SVGElement | null)[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) if (k) e.append(k);
  return e;
}

/** Text with `inline code` spans rendered as <code> elements (never parsed as HTML). */
export function codeText(s: string): DocumentFragment {
  const f = document.createDocumentFragment();
  s.split(/(`[^`]+`)/).forEach((part) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      const c = document.createElement('code');
      c.textContent = part.slice(1, -1);
      f.append(c);
    } else if (part) f.append(document.createTextNode(part));
  });
  return f;
}

/** The agent sigil: an ink asterisk for Claude, an ink hexagon for Codex. Decoration; the name goes in the label. */
export function sigil(agent: Agent, size = 18): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 20 20', width: size, height: size, 'aria-hidden': 'true', class: `pl-room-sigil is-${agent}` });
  if (agent === 'claude') {
    for (const a of [0, 60, 120]) s.append(svg('line', { x1: 10, y1: 2.5, x2: 10, y2: 17.5, transform: `rotate(${a} 10 10)`, stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round' }));
  } else {
    s.append(svg('polygon', { points: '10,2.5 16.5,6.25 16.5,13.75 10,17.5 3.5,13.75 3.5,6.25', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    s.append(svg('circle', { cx: 10, cy: 10, r: 2.2, fill: 'currentColor' }));
  }
  return s;
}

export function agentName(a: Agent): string {
  return AGENT_NAME[a];
}

/** A plain button whose click ends running animations first (the next input moves on), then acts. */
export function button(cls: string, label: Kid, onClick: () => void, o: { disabled?: boolean; aria?: string; pressed?: boolean } = {}): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  if (o.disabled) b.disabled = true;
  if (o.aria) b.setAttribute('aria-label', o.aria);
  if (o.pressed !== undefined) b.setAttribute('aria-pressed', String(o.pressed));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
