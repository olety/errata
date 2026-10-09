// Owner: boss/apply. Small DOM helpers shared by the boss and Apply screens. Log strings are always text: inline code
// becomes <code> built with textContent, never parsed HTML.

import type { DropBinder, ReceiptView } from '../contract';
import { tip } from '../cards';
import { splitTicks, tagText } from './model';

export type Kid = Node | string | null | false | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/** Text with backtick spans as <code> elements. */
export function rich(text: string): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const p of splitTicks(text)) {
    if (p.code) {
      const c = document.createElement('code');
      c.textContent = p.text;
      f.append(c);
    } else f.append(document.createTextNode(p.text));
  }
  return f;
}

/** R6: "Continue · leave it open" → ["Continue", "leave it open"]: the verb on the button, the rest in its tooltip. */
export function splitLabel(label: string): [string, string | null] {
  const at = label.indexOf(' · ');
  return at < 0 ? [label, null] : [label.slice(0, at), label.slice(at + 3)];
}

export function button(label: string, cls: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!b.disabled) onClick();
  });
  return b;
}

/** A binder that registers nothing: base-layer components rendered where no drop may land (Apply, the boss's books). */
export const INERT: DropBinder = { bindCard: () => () => undefined, bindTarget: () => () => undefined };

/** The head tag: agent, project, date, from the receipt. */
export function tag(r: Pick<ReceiptView, 'agent' | 'project' | 'date'>, cls = ''): HTMLElement {
  const t = el('span', `pl-end-tag pl-end-tag-${r.agent}${cls ? ` ${cls}` : ''}`, el('span', 'pl-end-sigil', ''), tagText(r));
  t.querySelector('.pl-end-sigil')!.setAttribute('aria-hidden', 'true');
  return t;
}

/** One complete receipt: the human's words (or "Tool evidence only"), the action and its result, then, agent, project, date. */
export function receipt(r: ReceiptView, opts: { compact?: boolean } = {}): HTMLElement {
  const quote = r.quote !== null ? el('blockquote', 'pl-end-quote', '“', rich(r.quote), '”') : el('p', 'pl-end-noquote', 'Tool evidence only');
  const act = r.action || r.result ? el('p', 'pl-end-act', r.action ? el('span', 'pl-end-mono', rich(r.action)) : null, r.action && r.result ? ' → ' : null, r.result ? el('span', 'pl-end-mono', rich(r.result)) : null) : null;
  const then = r.then ? el('p', 'pl-end-then', 'then ', el('span', 'pl-end-mono', rich(r.then))) : null;
  // The receipt's evidence is content the player reads, like the quote: the word-count check leaves it out.
  for (const n of [quote, act, then]) n?.setAttribute('data-density', 'content');
  return el('div', `pl-end-receipt${opts.compact ? ' pl-end-receipt-compact' : ''}`, quote, r.pasted ? el('span', 'pl-end-chip', 'pasted text') : null, act, then, tag(r));
}

/** A folded paper heron (a change of plan flies off, §4). Inline SVG: paper fill, ink folds, no gradient. */
export function heron(cls: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 80');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const shapes: [string, string][] = [
    ['5,44 25,55 20,50', '#efe4cc'],
    ['20,50 60,40 80,55 45,60', '#fbf2df'],
    ['35,48 55,8 62,42', '#efe4cc'],
    ['42,47 50,22 58,43', '#fbf2df'],
    ['60,40 72,18 76,20 66,44', '#fbf2df'],
    ['72,18 92,23 76,22', '#efe4cc'],
  ];
  for (const [points, fill] of shapes) {
    const p = document.createElementNS(ns, 'polygon');
    p.setAttribute('points', points);
    p.setAttribute('fill', fill);
    p.setAttribute('stroke', '#41291f');
    p.setAttribute('stroke-width', '1.2');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  for (const [x1, y1, x2, y2] of [
    [45, 60, 42, 78],
    [52, 58, 50, 78],
  ]) {
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', String(x1));
    l.setAttribute('y1', String(y1));
    l.setAttribute('x2', String(x2));
    l.setAttribute('y2', String(y2));
    l.setAttribute('stroke', '#41291f');
    l.setAttribute('stroke-width', '1.2');
    svg.append(l);
  }
  return svg;
}

/**
 * A printed tally line with each not-yet-judged excerpt ('Report what you changed…') as a link that opens that line's
 * inspector row (Accept / Does not apply, P4 item 3). The text is the view's; only the quoted excerpts become buttons.
 */
export function linkedLine(text: string, links: readonly { cardId: string; excerpt: string }[], open: (cardId: string) => void): Node[] {
  const out: Node[] = [];
  let rest = text;
  for (const l of links) {
    const q = `'${l.excerpt}'`;
    const at = rest.indexOf(q);
    if (at < 0) continue;
    if (at > 0) out.push(document.createTextNode(rest.slice(0, at)));
    const b = button(q, 'pl-end-link', () => open(l.cardId));
    tip(b, 'Open this line in the inspector: Accept this reading, or Does not apply');
    out.push(b);
    rest = rest.slice(at + q.length);
  }
  if (rest) out.push(document.createTextNode(rest));
  return out;
}
