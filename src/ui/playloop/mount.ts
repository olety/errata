// The integrator's mount: composes the four workers' components inside the Table for each screen, owns the one drag
// core, the inspector overlay, the paper drag ribbon and the tutorial's coach line, and repaints on every controller
// change. Workers never mount themselves; this file is where their exports are wired (WORKERS.md, "integration points").

import type * as C from './contract';
import type { Controller } from './controller';
import { DragCore } from './drag';
import { Books, Hand, Inspector, Piles } from './cards';
import { RouteHeader, StatusBar, Table } from './layout';
import { EventScreen, RoomScreen } from './room/room-screen';
import { RibbonLayer } from './room/ribbon';
import { CampfireScreen } from './campfire/campfire-screen';
import { BossScreen } from './end/boss-screen';
import { ApplyScreen } from './end/apply-screen';

function div(cls: string, ...kids: (Node | null)[]): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  for (const k of kids) if (k) e.append(k);
  return e;
}

/** The tutorial's coach line on the table's front edge: one per gesture, gone when done, never a modal (§11, §0a.16). */
function coach(ui: C.UiView): HTMLElement | null {
  if (!ui.tutorial) return null;
  const p = document.createElement('p');
  p.className = 'pl-coach';
  p.setAttribute('role', 'status');
  p.textContent = ui.tutorial.text;
  return p;
}

/** Every card a screen shows, for resolving the inspector's card when the adapter's view has none. */
function cardsOf(screen: C.Screen): C.CardView[] {
  switch (screen.kind) {
    case 'room':
    case 'event':
      return [...screen.view.hand, ...screen.view.unavailable, ...screen.view.deck, ...screen.view.piles.shelf];
    case 'campfire':
      return [...Object.values(screen.view.lanes).flat(), ...screen.view.piles.shelf, ...screen.view.ash];
    case 'boss':
      return screen.view.cards;
    default:
      return [];
  }
}

export function mountScreens(root: HTMLElement, ctl: Controller): () => void {
  const ribbon = RibbonLayer();
  const api = ctl.api;
  const core = new DragCore({
    onStart: () => undefined,
    onHover: (cardId, target) => void api.preview(cardId, target),
    onDrop: (cardId, target) => (target ? api.drop(cardId, target) : api.cancel()),
    onCancel: () => api.cancel(),
    // A tap on another card while one is selected stacks it there when that card is a target (the campfire); otherwise
    // it selects that card. A tap on the selected card keeps it selected (dealing selects the first card, and a player
    // who clicks it next must not lose it); Escape or "Clear selection" clears it.
    onTap: (cardId, under) => {
      const sel = ctl.ui.selected;
      if (sel && sel !== cardId && under?.kind === 'card') {
        // Stack only when the two share a thread (or a shelf card meets a deck card); otherwise the tap selects anew.
        const sc = ctl.screen();
        const linked = sc.kind !== 'campfire' || sc.view.piles.shelf.some((c) => c.id === sel) || sc.view.threads.some((t) => t.members.includes(sel) && t.members.includes(cardId));
        if (linked) return api.tapTarget(under);
      }
      api.select(cardId);
    },
    onInspect: (cardId) => api.inspect({ cardId }),
    onTapTarget: (target) => api.tapTarget(target),
    ribbon: (from, to) => (ctl.ui.reducedMotion ? undefined : ribbon.draw(from, to)),
  });
  const drag: C.DropBinder = { bindCard: (id, el) => core.bindCard(id, el), bindTarget: (id, t, el) => core.bindTarget(id, t, el) };
  const inspectHead = { inspect: (ref: { caseId: string } | null) => api.inspect(ref) };

  const paint = () => {
    core.resetTargets();
    const screen = ctl.screen();
    const ui = ctl.uiView();
    const b = ui.bands;
    let header: HTMLElement;
    let stage: HTMLElement;
    let wood: HTMLElement;
    let status: HTMLElement;
    switch (screen.kind) {
      case 'room':
      case 'event': {
        const v = screen.view;
        const props: C.ScreenProps<C.RoomView> = { view: v, ui, api, drag };
        header = RouteHeader({ route: v.route, title: v.beast.name, subtitle: v.beast.subtitle, api: inspectHead });
        stage = screen.kind === 'event' ? EventScreen(props) : RoomScreen(props);
        // The books and piles stay dim while heads wait for stamps (P3 gate fix E): the slip is the first thing to do.
        wood = div(
          `pl-wood${v.phase === 'judge' && v.review.remaining > 0 ? ' is-waiting' : ''}`,
          Books({
            books: v.books,
            preview: ui.drag?.preview ?? null,
            mode: 'play',
            layout: b.books.mode,
            drag,
            cards: v.deck,
            onInspect: (id) => api.inspect({ cardId: id }),
            ink: v.result,
            onRaise: (lane, to) => api.campfire.raiseAllowance(lane, to),
          }),
          Hand({ cards: v.hand, bands: b, ui, api, drag }),
          Piles({ piles: v.piles, layout: b.piles.mode, shelfTarget: v.phase === 'dealt', api, drag }),
        );
        status = StatusBar({ status: v.status, notice: ui.notice });
        break;
      }
      case 'campfire': {
        const v = screen.view;
        const parts = CampfireScreen({ view: v, ui, api, drag });
        header = RouteHeader({ route: v.route, title: 'Campfire', subtitle: 'Make room: merge, shorten, cut, or move a procedure into a Skill.', api: inspectHead });
        stage = parts.stage;
        wood = parts.wood;
        status = StatusBar({ status: v.status, notice: ui.notice });
        break;
      }
      case 'boss': {
        const v = screen.view;
        const parts = BossScreen({ view: v, ui, api, drag });
        const title = v.kind === 'audit' ? 'Final audit' : 'Later cases';
        const subtitle = v.kind === 'audit' ? 'Your open pages face the final deck.' : 'The cases held back rise one at a time: read, stamp blind, then answer with your own cards.';
        header = RouteHeader({ route: v.route, title, subtitle, api: inspectHead });
        stage = parts.stage;
        wood = parts.wood;
        status = StatusBar({ status: v.status, notice: ui.notice });
        break;
      }
      case 'apply': {
        const v = screen.view;
        const parts = ApplyScreen({ view: v, ui, api, drag });
        header = RouteHeader({ route: v.route, title: 'Apply', subtitle: 'Both diffs, then the seal: backups first, every write read back, Undo after.', api: inspectHead });
        stage = parts.stage;
        wood = parts.wood;
        status = StatusBar({ status: v.status, notice: ui.notice });
        break;
      }
      default: {
        header = div('pl-header');
        stage = div('pl-empty', document.createTextNode(screen.text));
        wood = div('pl-wood');
        status = StatusBar({ status: { sample: false, text: '' }, notice: ui.notice });
      }
    }
    // The coach line is written along the table's front edge, where it never covers a card or a target; the campfire
    // prints its own beside the threads it points at.
    const line = screen.kind === 'campfire' ? null : coach(ui);
    if (line) status.append(line);
    // Phones below 500 px: the page scrolls (the body lets it), the Table is in the flow.
    document.body.classList.toggle('is-flow', b.flow);
    const table = Table({ bands: b, header, stage, wood, status });
    // The tutorial's spotlight on a card (the campfire spotlights its own threads).
    const f = ui.tutorial?.focus;
    if (f?.kind === 'card') for (const n of table.querySelectorAll<HTMLElement>(`[data-card="${CSS.escape(f.cardId)}"]`)) n.classList.add('pl-spot');
    let inspector: HTMLElement | null = null;
    if (ui.inspect) {
      const id = 'cardId' in ui.inspect ? ui.inspect.cardId : null;
      const card = id ? cardsOf(screen).find((c) => c.id === id) ?? null : null;
      inspector = Inspector({ card, receipt: null, layout: b.mode === 'phone' ? 'sheet' : 'side', api, view: ui.inspector });
    }
    root.replaceChildren(table, ...(inspector ? [inspector] : []), ribbon.el);
    // In the flow the room's controls stick just above the status strip, whatever its height (the coach can wrap).
    if (b.flow) {
      const st = table.querySelector<HTMLElement>('.pl-layout-status');
      if (st) table.style.setProperty('--pl-status-h', `${st.offsetHeight}px`);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    // A component that owned the key (the campfire's seal, a field) already handled it.
    if (e.defaultPrevented) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
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
