// The integrator's mount: composes the four workers' components inside the Table for each screen, owns the one drag
// core and the inspector and ribbon overlays, and repaints on every controller change. Workers never mount
// themselves; this file is where their exports are wired (WORKERS.md, "integration points").

import type * as C from './contract';
import type { Controller } from './controller';
import { DragCore } from './drag';
import { Books, Hand, Inspector, Piles } from './cards';
import { RouteHeader, StatusBar, Table } from './layout';
import { EventScreen, RoomScreen } from './room/room-screen';
import { CampfireScreen } from './campfire/campfire-screen';
import { BossScreen } from './end/boss-screen';
import { ApplyScreen } from './end/apply-screen';

function div(cls: string, ...kids: (Node | null)[]): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  for (const k of kids) if (k) e.append(k);
  return e;
}

/** The plain ribbon overlay; the room/rig worker replaces it with the paper ribbon (reduced motion: none). */
function ribbonLayer(): { el: SVGSVGElement; draw(from: { x: number; y: number }, to: { x: number; y: number } | null): void } {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:50');
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('stroke', '#b08a3e');
  line.setAttribute('stroke-width', '3');
  svg.append(line);
  return {
    el: svg,
    draw(from, to) {
      line.setAttribute('visibility', to ? 'visible' : 'hidden');
      if (!to) return;
      line.setAttribute('x1', String(from.x));
      line.setAttribute('y1', String(from.y));
      line.setAttribute('x2', String(to.x));
      line.setAttribute('y2', String(to.y));
    },
  };
}

export function mountScreens(root: HTMLElement, ctl: Controller): () => void {
  const ribbon = ribbonLayer();
  const api = ctl.api;
  const core = new DragCore({
    onStart: () => undefined,
    onHover: (cardId, target) => void api.preview(cardId, target),
    onDrop: (cardId, target) => (target ? api.drop(cardId, target) : api.cancel()),
    onCancel: () => api.cancel(),
    onTap: (cardId) => api.select(ctl.ui.selected === cardId ? null : cardId),
    onInspect: (cardId) => api.inspect({ cardId }),
    onTapTarget: (target) => api.tapTarget(target),
    ribbon: (from, to) => (ctl.ui.reducedMotion ? undefined : ribbon.draw(from, to)),
  });
  const drag: C.DropBinder = { bindCard: (id, el) => core.bindCard(id, el), bindTarget: (id, t, el) => core.bindTarget(id, t, el) };

  const paint = () => {
    core.resetTargets();
    const screen = ctl.screen();
    const ui = ctl.uiView();
    const b = ui.bands;
    let header: HTMLElement;
    let stage: HTMLElement;
    let wood: HTMLElement;
    let status: HTMLElement;
    let inspectCard: C.CardView | null = null;
    switch (screen.kind) {
      case 'room':
      case 'event': {
        const v = screen.view;
        const props: C.ScreenProps<C.RoomView> = { view: v, ui, api, drag };
        header = RouteHeader({ route: v.route, title: v.beast.name, subtitle: v.beast.subtitle });
        stage = screen.kind === 'event' ? EventScreen(props) : RoomScreen(props);
        wood = div(
          'pl-wood',
          Books({ books: v.books, preview: ui.drag?.preview ?? null, mode: 'play', layout: b.books.mode, drag }),
          Hand({ cards: v.hand, bands: b, ui, api, drag }),
          Piles({ piles: v.piles, layout: b.piles.mode, shelfTarget: v.phase === 'dealt', api, drag }),
        );
        status = StatusBar({ status: v.status, notice: ui.notice });
        if (ui.inspect && 'cardId' in ui.inspect) inspectCard = [...v.hand, ...v.unavailable].find((c) => c.id === (ui.inspect as { cardId: string }).cardId) ?? null;
        break;
      }
      case 'campfire': {
        const v = screen.view;
        const parts = CampfireScreen({ view: v, ui, api, drag });
        header = RouteHeader({ route: v.route, title: 'Campfire', subtitle: 'Make room: merge, shorten, cut, or move a procedure into a Skill.' });
        stage = parts.stage;
        wood = parts.wood;
        status = StatusBar({ status: v.status, notice: ui.notice });
        if (ui.inspect && 'cardId' in ui.inspect) inspectCard = Object.values(v.lanes).flat().find((c) => c.id === (ui.inspect as { cardId: string }).cardId) ?? null;
        break;
      }
      case 'boss': {
        const parts = BossScreen({ view: screen.view, ui, api, drag });
        header = div('pl-header');
        stage = parts.stage;
        wood = parts.wood;
        status = StatusBar({ status: { sample: false, text: '' }, notice: ui.notice });
        break;
      }
      case 'apply': {
        const parts = ApplyScreen({ view: screen.view, ui, api, drag });
        header = div('pl-header');
        stage = parts.stage;
        wood = parts.wood;
        status = StatusBar({ status: { sample: false, text: '' }, notice: ui.notice });
        break;
      }
      default: {
        header = div('pl-header');
        stage = div('pl-empty', document.createTextNode(screen.text));
        wood = div('pl-wood');
        status = StatusBar({ status: { sample: false, text: '' }, notice: ui.notice });
      }
    }
    const table = Table({ bands: b, header, stage, wood, status });
    const inspector = ui.inspect ? Inspector({ card: inspectCard, receipt: null, layout: b.mode === 'phone' ? 'sheet' : 'side', api }) : null;
    root.replaceChildren(table, ...(inspector ? [inspector] : []), ribbon.el);
  };

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (ctl.key(e.key, e.shiftKey)) e.preventDefault();
  };
  const onResize = () => ctl.resize({ w: window.innerWidth, h: window.innerHeight });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  const unsub = ctl.subscribe(paint);
  paint();
  return () => {
    unsub();
    core.destroy();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
  };
}
