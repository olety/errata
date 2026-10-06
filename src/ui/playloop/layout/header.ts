// Owner: cards/layout. P0 stub: replace the body; keep the export names and props (WORKERS.md lists them).
// Import from ../contract, and from ../cards (the base layer's exported components) only. Never the adapter or the engine.
import type { RouteView, StatusView } from '../contract';

/** Text-only element helper (log strings are never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/** The route (8 knots) centred in the header, with the sealed boss heads as a count and sigils only (§1, §5.5). */
export function RouteHeader(p: { route: RouteView; title: string; subtitle: string }): HTMLElement {
  return el('header', 'pl-header', el('nav', '', ...p.route.knots.map((k) => el('span', k.state, String(k.slot)))), el('h1', '', p.title), el('p', '', p.subtitle));
}

/** The status bar: "synthetic sample · 12 sessions", the notice line. Nothing here is a drop target. */
export function StatusBar(p: { status: StatusView; notice: string | null }): HTMLElement {
  return el('footer', 'pl-status', p.status.text, p.notice ? el('span', '', ` · ${p.notice}`) : null);
}
