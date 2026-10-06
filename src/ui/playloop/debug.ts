// A plain debug render of the play loop: every view field as text, every act as a button, every card draggable and
// every drop target registered through the drag core. No styling beyond what keeps targets at 44 px. The four workers
// replace this screen by screen; until then it proves the contract end to end in a browser.

import type * as C from './contract';
import { STAMPS } from './contract';
import type { Controller } from './controller';
import { DragCore } from './drag';

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') e.className = String(v);
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

const STYLE = `
.pl { font: 14px/1.4 system-ui, sans-serif; padding: 8px 16px; color: #222; }
.pl .box { border: 1px solid #999; padding: 6px; margin: 4px; min-width: 44px; min-height: 44px; display: inline-block; vertical-align: top; }
.pl .card { width: 176px; min-height: 120px; background: #fffdf6; cursor: grab; }
.pl .glow { outline: 3px solid gold; }
.pl .target { background: #f3f3f3; }
.pl .word { color: #a33; font-weight: 600; }
.pl button { min-height: 44px; min-width: 44px; margin: 2px; }
.pl .mono { font-family: ui-monospace, monospace; white-space: pre-wrap; }
.pl .sub { color: #666; }
.pl .notice { background: #fee; padding: 6px; }
`;

export function mountDebug(root: HTMLElement, ctl: Controller): () => void {
  const style = el('style', {}, STYLE);
  document.head.append(style);
  let core: DragCore | null = null;
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (ctl.key(e.key, e.shiftKey)) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);

  let previewEl: HTMLElement | null = null;
  const paint = () => {
    // While a press or drag is live, only the preview line changes; rebuilding would drop the card under the pointer.
    if (core?.active()) {
      const p = ctl.uiView().drag?.preview;
      if (previewEl) previewEl.textContent = p ? `${p.verb} · ${p.heads.map((h) => (h.glow ? 'glow' : h.word ?? '·')).join(' | ')} · CLAUDE.md ${p.ghost.claude.text} · AGENTS.md ${p.ghost.codex.text} (estimated)${p.refused ? ` · ${p.refused}` : ''}` : '';
      return;
    }
    core?.destroy();
    const api = ctl.api;
    core = new DragCore({
      onStart: () => undefined,
      onHover: (cardId, target) => void api.preview(cardId, target),
      onDrop: (cardId, target) => (target ? api.drop(cardId, target) : api.cancel()),
      onCancel: () => api.cancel(),
      onTap: (cardId) => api.select(ctl.ui.selected === cardId ? null : cardId),
      onInspect: (cardId) => api.inspect({ cardId }),
      onTapTarget: (target) => api.tapTarget(target),
    });
    const ui = ctl.uiView();
    const screen = ctl.screen();
    const glow = new Map((ui.drag?.preview?.heads ?? []).map((h) => [h.caseId, h]));
    const target = (id: string, t: C.DragTarget, ...kids: Kid[]) => {
      const b = el('div', { class: 'box target', 'data-target': id }, ...kids);
      core!.bindTarget(id, t, b);
      return b;
    };
    const card = (c: C.CardView, asTarget?: C.DragTarget) => {
      const b = el(
        'div',
        { class: `box card${ui.selected === c.id ? ' glow' : ''}`, 'data-card': c.id },
        el('b', {}, c.face.title),
        el('div', {}, c.face.summary),
        c.face.mark && el('div', { class: 'sub' }, c.face.mark),
        el('div', { class: 'sub' }, `+${c.weight} est. · ${c.targets} · ${c.scope} · ${c.provenance}`),
        c.footer && el('div', { class: 'sub' }, c.footer.text),
        c.exceptions.length > 0 && el('div', { class: 'sub' }, `exceptions: ${c.exceptions.join('; ')}`),
        c.inspector.unavailable.length > 0 && el('div', { class: 'word' }, `not dealt: ${c.inspector.unavailable.join('; ')}`),
      );
      core!.bindCard(c.id, b);
      if (asTarget) core!.bindTarget(`card:${c.id}`, asTarget, b);
      return b;
    };
    const books = (bs: C.BookView[], kind: 'book' | 'book-retarget') =>
      el(
        'div',
        {},
        ...bs.map((b) => {
          const g = ui.drag?.preview?.ghost[b.lane];
          return target(`book:${b.lane}`, { kind, lane: b.lane }, el('b', {}, `${b.file}${b.proposed ? ' · Proposed' : ''}`), el('div', {}, `${b.weight.now} / ${b.weight.allowance} estimated${b.weight.over ? ' · clasp open' : ''}${b.blocked ? ` · blocked: ${b.blocked}` : ''}`), g && el('div', { class: 'sub' }, `ghost ${g.before} → ${g.after}: ${g.text}`));
        }),
      );
    const piles = (p: C.PilesView) =>
      el('div', {}, target('shelf', { kind: 'shelf' }, el('b', {}, `Shelf · ${p.shelf.length}`)), el('div', { class: 'box' }, el('b', {}, `Open · ${p.open.length}`), ...p.open.map((o) => el('div', { class: 'sub' }, `${o.tag.agent} · ${o.tag.project ?? ''} · ${o.tag.date ?? ''}`))));
    const route = (r: C.RouteView, st: C.StatusView) =>
      el('div', { class: 'sub' }, `${st.text} · sealed ${r.sealed.count} (${r.sealed.sigils.join(', ')}) · `, ...r.knots.map((k) => `${k.state === 'current' ? '▶' : ''}${k.slot} ${k.label}${k.open ? ` · open ${k.open}` : ''}${k.unreviewed ? ` · ${k.unreviewed} wrapped` : ''}  `));
    const receipt = (r: C.ReceiptView | null) =>
      r ? el('div', { class: 'box' }, el('div', {}, r.quote ? `“${r.quote}”` : 'Tool evidence only'), el('div', { class: 'mono sub' }, `${r.action ?? ''}\n${r.result ?? ''}`), el('div', { class: 'sub' }, `${r.agent} · ${r.project ?? ''} · ${r.date ?? ''}`)) : null;
    const body: Kid[] = [];
    if (screen.kind === 'room' || screen.kind === 'event') {
      const v = screen.view;
      body.push(
        route(v.route, v.status),
        el('h2', {}, `${v.beast.name} · ${v.beast.pips.text}`),
        el('div', { class: 'sub' }, v.beast.subtitle),
        target(
          'beast',
          { kind: 'beast' },
          el('b', {}, `beast (${v.beast.skin})`),
          ...v.heads.map((h) => {
            const g = glow.get(h.caseId);
            return target(`head:${h.caseId}`, { kind: 'head', caseId: h.caseId }, el('div', { class: g?.glow ? 'glow' : '' }, `${h.state} · ${h.tag.agent} · ${h.tag.project ?? ''} · ${h.tag.date ?? ''}${h.rings ? ` · ${h.rings.count} ${h.rings.counts}` : ''}`), g?.word && el('div', { class: 'word' }, g.word));
          }),
          v.beast.overflow && el('div', {}, v.beast.overflow.text),
        ),
        receipt(v.receipts.current),
        v.phase === 'judge' && v.receipts.current && el('div', {}, ...STAMPS.map((s) => el('button', { onclick: () => api.stamp(v.receipts.current!.caseId, s.stamp) }, `${s.label} (${s.key.toUpperCase()})`))),
        el('div', { class: 'sub' }, `queue: ${v.receipts.queue.length} · phase ${v.phase} · beat ${ui.beat}${v.finalizes ? ` · ${v.finalizes}` : ''}`),
        el(
          'div',
          {},
          v.canDeal && el('button', { onclick: () => api.deal() }, 'Deal'),
          v.phase === 'dealt' && el('button', { onclick: () => api.pullBack() }, 'Pull the hand back'),
          v.phase === 'dealt' && el('button', { onclick: () => api.skip() }, 'Skip'),
          (v.phase === 'done' || v.offer || v.kind === 'event') && el('button', { onclick: () => api.advance() }, v.offer === 'keep-existing' ? 'Keep existing' : 'Continue'),
        ),
        ...v.existingAsks.map((a) => el('div', { class: 'box' }, `Already in your file. Does it answer this case? ${a.line}`, el('button', { onclick: () => api.answerExisting(a.cardId, a.caseId, true) }, 'Yes'), el('button', { onclick: () => api.answerExisting(a.cardId, a.caseId, false) }, 'No'))),
        el('div', {}, ...v.hand.map((c) => card(c))),
        v.unavailable.length > 0 && el('details', {}, el('summary', {}, `${v.unavailable.length} not dealt`), ...v.unavailable.map((c) => card(c))),
        ui.drag?.preview?.line && el('div', { class: 'box mono' }, `${ui.drag.preview.line.text}\n${ui.drag.preview.line.scope} · ${ui.drag.preview.line.files.join(', ')}${ui.drag.preview.refused ? `\n${ui.drag.preview.refused}` : ''}`),
        books(v.books, 'book'),
        piles(v.piles),
        v.result && el('div', { class: 'mono sub' }, `result: bound ${v.result.bound.length} · standing ${v.result.standing.length} · ink ${v.result.ink.map((i) => i.file).join(', ')}`),
      );
    } else if (screen.kind === 'campfire') {
      const v = screen.view;
      body.push(
        route(v.route, v.status),
        el('h2', {}, 'Campfire'),
        v.coach && el('div', { class: 'notice' }, v.coach),
        el('div', {}, ...(['claude', 'both', 'codex'] as const).map((t) => el('button', { onclick: () => api.campfire.tab(t) }, `${t} (${v.lanes[t].length})${v.tab === t ? ' ◀' : ''}`))),
        el('div', {}, ...v.lanes[v.tab].map((c) => card(c, { kind: 'card', cardId: c.id }))),
        target('fire', { kind: 'fire' }, el('b', {}, 'the fire (cut)')),
        ...v.threads.map((t) =>
          el(
            'div',
            { class: 'box' },
            el('b', {}, `${t.color} · ${t.reason}`),
            el('div', { class: 'sub' }, t.members.join(' + ')),
            t.color === 'gold' && t.autoText && el('button', { onclick: () => api.campfire.fuse(t.id, t.autoText!) }, `Seal: ${t.autoText}`),
            t.color === 'red' && el('button', { onclick: () => api.campfire.settle(t.id, { kind: 'keep', keep: t.members[0]! }) }, 'Keep the first'),
            t.color === 'red' && el('button', { onclick: () => api.campfire.settle(t.id, { kind: 'cancel' }) }, 'Cancel'),
          ),
        ),
        ui.pending && el('div', { class: 'notice' }, `pending: ${JSON.stringify(ui.pending)}`, ui.pending.kind === 'cut' && el('button', { onclick: () => api.campfire.cut((ui.pending as { cardId: string }).cardId) }, 'Burn it'), el('button', { onclick: () => api.cancel() }, 'Cancel')),
        books(v.books, 'book-retarget'),
        piles(v.piles),
        v.ash.length > 0 && el('div', {}, 'Ash: ', ...v.ash.map((c) => el('button', { onclick: () => api.campfire.restore(c.id) }, `Restore ${c.face.title}`))),
        el('button', { onclick: () => api.advance() }, 'Leave the campfire'),
      );
    } else if (screen.kind === 'boss') {
      const v = screen.view;
      body.push(
        el('h2', {}, v.kind === 'boss' ? 'Later cases' : 'Final audit'),
        ...v.heads.map((h) => {
          const cur = h.caseId === v.current;
          return target(`boss:${h.caseId}`, { kind: 'head', caseId: h.caseId }, el('b', {}, `${h.source} · ${h.disposition}${h.addressed ? ' · addressed' : ''}${cur ? ' ◀' : ''}`), receipt(h.receipt), cur && h.disposition === 'unreviewed' && h.source === 'sealed' && el('div', {}, ...STAMPS.map((s) => el('button', { onclick: () => api.boss.stamp(h.caseId, s.stamp) }, s.label))));
        }),
        v.noEligibleCard && el('div', { class: 'word' }, 'No eligible card'),
        ...v.candidates.map((c) => el('div', { class: c.glow ? 'glow box' : 'box' }, c.cardId, c.reason && el('span', { class: 'word' }, ` · ${c.reason}`), c.glow && v.current && el('button', { onclick: () => api.boss.answer(c.cardId, v.current!) }, 'Answer'))),
        el('button', { onclick: () => api.boss.next() }, 'Continue'),
        ...v.score.lines.map((l) => el('div', {}, l)),
        el('div', { class: 'sub' }, `locked ${v.score.locked} · stale ${v.score.stale}`),
        !v.current && el('button', { onclick: () => api.advance() }, 'Go to Apply'),
      );
    } else if (screen.kind === 'apply') {
      const v = screen.view;
      body.push(
        el('h2', {}, 'Apply'),
        ...v.blockers.map((b) => el('div', { class: 'notice' }, b.text, el('button', { onclick: () => api.apply.returnToCampfire(b.select) }, 'Return to the final campfire'))),
        ...v.notes.map((n) => el('div', { class: 'sub' }, n)),
        ...v.diffs.map((d) => el('div', { class: 'box' }, el('b', {}, d.path), d.weight && el('div', { class: 'sub' }, `${d.weight.before} → ${d.weight.after} of ${d.weight.allowance} estimated`), el('div', { class: 'mono' }, d.ops.filter((o) => o.op !== 'same').map((o) => `${o.op === 'add' ? '+' : '−'} ${o.line}`).join('\n')))),
        el('div', {}, `Reviewed ${v.stamps.reviewed} · Fits ${v.stamps.fits} · Written ${v.stamps.written}`),
        el('button', { onclick: () => void api.apply.prepare() }, 'Rebuild the diff'),
        v.canSeal && el('button', { onclick: () => void api.apply.seal() }, 'Seal'),
        v.result && el('div', {}, v.result.text, v.result.bundle && el('button', { onclick: () => void api.apply.undo() }, 'Undo')),
        v.undo && el('div', { class: 'mono' }, v.undo.text ?? v.undo.files.map((f) => `${f.path}: ${f.text}`).join('\n')),
        el('footer', { class: 'sub' }, v.footer),
      );
    } else {
      body.push(el('p', {}, screen.text), el('button', { onclick: () => api.advance() }, 'Continue'));
    }
    previewEl = el('div', { class: 'mono sub', 'data-preview': '1' });
    root.replaceChildren(el('div', { class: 'pl' }, el('div', { class: 'sub' }, 'Play loop · debug render'), ui.notice && el('div', { class: 'notice' }, ui.notice), previewEl, ...body));
  };
  const unsub = ctl.subscribe(paint);
  const onResize = () => ctl.resize({ w: window.innerWidth, h: window.innerHeight });
  window.addEventListener('resize', onResize);
  paint();
  return () => {
    unsub();
    core?.destroy();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    style.remove();
  };
}
