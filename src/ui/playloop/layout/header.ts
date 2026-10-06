// Owner: cards/layout. The header band (route, pattern name, factual subtitle) and the status bar (§1, §5.5).
// Import from ../contract only. Never the adapter or the engine.
import type { ControllerApi, RouteKnotView, RouteView, StatusView } from '../contract';
import { el, Sigil, svg } from '../cards/dom';
import './layout.css';

/** Knot glyphs, one per node kind (16 px, ink stroke; the current knot gets a ring). */
const KNOT: Record<RouteKnotView['kind'], { d: string; fill?: boolean }[]> = {
  encounter: [{ d: 'M8 3.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z', fill: true }],
  elite: [{ d: 'M8 2.5 13.5 8 8 13.5 2.5 8Z', fill: true }],
  review: [{ d: 'M8 3a5 5 0 1 1 0 10A5 5 0 0 1 8 3Z' }, { d: 'M8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z', fill: true }],
  event: [{ d: 'M8 3 13 8 8 13 3 8Z' }],
  campfire: [{ d: 'M8 3 13.2 12.5H2.8Z', fill: true }],
  workshop: [{ d: 'M3.5 4h9v8.5h-9Z' }],
  'card-review': [{ d: 'M3.5 4h9v8.5h-9Z' }, { d: 'M5.6 8.4 7.3 10l3.2-3.6' }],
  boss: [{ d: 'M2.8 12.5 4 5.5l2.4 2.8L8 4l1.6 4.3L12 5.5l1.2 7Z', fill: true }],
  audit: [{ d: 'M2.8 12.5 4 5.5l2.4 2.8L8 4l1.6 4.3L12 5.5l1.2 7Z' }],
  apply: [{ d: 'M8 2.8a5.2 5.2 0 1 1 0 10.4A5.2 5.2 0 0 1 8 2.8Z' }, { d: 'M5.6 8.2 7.3 9.8l3.1-3.4' }],
};

export interface RouteHeaderProps {
  route: RouteView;
  title: string;
  subtitle: string;
  /**
   * Optional (not in the frozen props; see the contract asks): when given, a knot with in-room cases opens their
   * receipts in the inspector. Without it the knots are read-only.
   */
  api?: Pick<ControllerApi, 'inspect'> | null;
}

/** The route (8 knots) centred in the header, with the sealed boss heads as a count and sigils only (§1, §5.5). */
export function RouteHeader(p: RouteHeaderProps): HTMLElement {
  const r = p.route;
  const list = el('ol', 'pl-layout-route');
  for (const k of r.knots) {
    const marks = el(
      'span',
      'pl-layout-marks',
      k.open > 0 ? el('span', 'pl-layout-mark-open', String(k.open)) : null,
      k.unreviewed > 0 ? el('span', 'pl-layout-mark-unrev', String(k.unreviewed)) : null,
    );
    const words = [k.label, k.state === 'current' ? 'here' : k.state === 'done' ? 'done' : 'ahead', `${k.heads} heads`, `${k.open} open`, `${k.unreviewed} unreviewed`].join(' · ');
    const knot = el('button', `pl-layout-knot is-${k.state} is-${k.kind}`, svg('0 0 16 16', 'pl-layout-knot-glyph', KNOT[k.kind]), marks);
    knot.type = 'button';
    knot.title = words;
    knot.setAttribute('aria-label', words);
    if (k.state === 'current') knot.setAttribute('aria-current', 'step');
    const first = k.caseIds[0];
    if (p.api && first) knot.addEventListener('click', () => p.api!.inspect({ caseId: first }));
    else knot.disabled = true;
    list.append(el('li', `pl-layout-knot-li is-${k.state}`, knot));
  }
  const sealed =
    r.sealed.count > 0
      ? el('span', 'pl-layout-sealed', el('b', 'pl-layout-num', String(r.sealed.count)), ' sealed', ...r.sealed.sigils.map((a) => Sigil(a, true)))
      : null;
  if (sealed) sealed.title = `${r.sealed.count} later cases held back for the end: agents only, no words`;
  const bar = el('nav', 'pl-layout-routebar', list, sealed);
  bar.setAttribute('aria-label', 'Route');
  // On a narrow screen the route scrolls sideways: keep the current knot in view.
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => {
      const cur = bar.querySelector<HTMLElement>('.pl-layout-knot-li.is-current');
      if (cur && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = Math.max(0, cur.offsetLeft - (bar.clientWidth - cur.offsetWidth) / 2);
    });
  return el('header', 'pl-layout-head', bar, el('h1', 'pl-layout-title', p.title), p.subtitle ? el('p', 'pl-layout-sub', p.subtitle) : null);
}

/** The status bar: "synthetic sample · 12 sessions", the notice line. Nothing here is a drop target. */
export function StatusBar(p: { status: StatusView; notice: string | null }): HTMLElement {
  const bar = el('footer', `pl-layout-statusbar${p.status.sample ? ' is-sample' : ''}`, p.status.text ? el('span', 'pl-layout-status-text', p.status.text) : null);
  if (p.notice) {
    const n = el('span', 'pl-layout-notice', p.notice);
    n.setAttribute('role', 'status');
    bar.append(n);
  }
  return bar;
}
