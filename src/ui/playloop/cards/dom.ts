// Owner: cards/layout. Small DOM and presentation helpers shared by the base layer. Log strings are text, never HTML:
// every node is built with createElement and textContent. Nothing here computes a game number; the pure helpers only
// split strings, format figures the views already hold, and measure presentation geometry.

import type { Agent, CardView } from '../contract';

export type Kid = Node | string | null | false | undefined;

/** Text-only element helper. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/** A plain button that never starts a card drag (pointerdown stops at the button). */
export function button(cls: string, label: Kid, onClick: () => void, aria?: string): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  if (aria) b.setAttribute('aria-label', aria);
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// ------------------------------------------------------------------ pure: inline code spans

/** Split a log string on backtick spans: `code` becomes a code part. An unmatched backtick stays text. */
export function splitCode(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('`', i);
    const close = open < 0 ? -1 : text.indexOf('`', open + 1);
    if (open < 0 || close < 0) {
      out.push({ code: false, text: text.slice(i) });
      break;
    }
    if (open > i) out.push({ code: false, text: text.slice(i, open) });
    if (close > open + 1) out.push({ code: true, text: text.slice(open + 1, close) });
    i = close + 1;
  }
  return out.filter((p) => p.text.length > 0);
}

/** Inline code arrives as backtick spans; render them as <code> elements built with textContent. */
export function inline(text: string): Node[] {
  return splitCode(text).map((p) => {
    if (!p.code) return document.createTextNode(p.text);
    const c = document.createElement('code');
    c.textContent = p.text;
    return c;
  });
}

// ------------------------------------------------------------------ pure: figures

/** A view's figure with thousands separators ("1,200"). Formatting only; the number is the view's. */
export function fig(n: number): string {
  const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `−${s}` : s;
}

// ------------------------------------------------------------------ pure: card art

export type ArtKey = 'retry' | 'scope' | 'verify';

/**
 * Which painted plate fills the art window. Decoration only: it encodes nothing and never changes a number. The view's
 * art key (CardView.art, from the card's family) decides; a card without one falls back to its own fields.
 */
export function cardArt(card: Pick<CardView, 'type' | 'provenance'> & { inspector: { trigger: string | null }; art?: CardView['art'] }): ArtKey | null {
  if (card.art !== undefined) return card.art;
  if (card.type === 'protected' || card.type === 'trait') return null;
  if (card.type === 'skill' || card.provenance.startsWith('Verified')) return 'verify';
  const t = (card.inspector.trigger ?? '').toLowerCase();
  if (/(fail|retry|rerun|repeated command|error)/.test(t)) return 'retry';
  return 'scope';
}

/** Where each plate's subject sits in its 2:3 frame, for the 4:3 crop. */
export const ART_FOCUS: Record<ArtKey, string> = { retry: '50% 58%', scope: '50% 3%', verify: '50% 36%' };

/** Public asset URL under Vite's base (the dev server and the Pages build both serve /errata/). */
export function asset(path: string): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}playloop/${path}`;
}

// ------------------------------------------------------------------ sigils and glyphs (inline SVG, no network)

const NS = 'http://www.w3.org/2000/svg';

export function svg(viewBox: string, cls: string, paths: { d: string; fill?: boolean }[], label?: string): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('class', cls);
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
  } else s.setAttribute('aria-hidden', 'true');
  for (const p of paths) {
    const e = document.createElementNS(NS, 'path');
    e.setAttribute('d', p.d);
    if (p.fill) e.setAttribute('class', 'is-fill');
    s.append(e);
  }
  return s;
}

/** The agent sigil: Claude a six-ray star, Codex a prompt chevron. Filled when the card targets that agent. */
export function Sigil(agent: Agent, on: boolean): HTMLElement {
  const name = agent === 'claude' ? 'Claude' : 'Codex';
  const d =
    agent === 'claude'
      ? 'M8 1.5 9.3 6.2 13.6 4 10.4 7.6 14.5 9.6 9.8 9.4 10.4 14.3 8 10.1 5.6 14.3 6.2 9.4 1.5 9.6 5.6 7.6 2.4 4 6.7 6.2Z'
      : 'M2.6 4.2 7.2 8l-4.6 3.8M8.6 12.2h5';
  const s = el('span', `pl-cards-sigil pl-cards-sigil-${agent}${on ? ' is-on' : ''}`);
  s.title = on ? `${name}: in this card's targets` : `${name}: not targeted`;
  s.append(svg('0 0 16 16', '', [{ d, fill: agent === 'claude' }], on ? `${name}, targeted` : `${name}, not targeted`));
  return s;
}

/** Type glyphs: quill = Rule, tome = Skill, wax lock = Protected text, hand mirror = Trait. */
export function TypeGlyph(type: CardView['type']): SVGSVGElement {
  const d: Record<CardView['type'], { d: string; fill?: boolean }[]> = {
    rule: [{ d: 'M13.5 2.5C9 3 5.5 6.5 4 11.5l-1 2.5M13.5 2.5c-.5 3.5-3 6.5-7.2 7.6M6.8 6.6 9 8.6' }],
    skill: [{ d: 'M3 3.2h4.2c.7 0 .8.4.8 1v9.3c0-.7-.4-1-1-1H3ZM13 3.2H8.8c-.7 0-.8.4-.8 1v9.3c0-.7.4-1 1-1H13Z' }],
    protected: [{ d: 'M5 7V5.2a3 3 0 0 1 6 0V7' }, { d: 'M3.5 7h9v6.5h-9Z', fill: true }],
    trait: [{ d: 'M8 2a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM8 9v5M6.2 12.4h3.6' }],
  };
  const label = { rule: 'Rule', skill: 'Skill', protected: 'Protected text', trait: 'Trait' }[type];
  return svg('0 0 16 16', 'pl-cards-glyph', d[type], label);
}
