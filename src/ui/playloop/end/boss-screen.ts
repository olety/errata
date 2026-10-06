// Owner: boss/apply. The boss (play-loop §9, §0a.12): at blue hour the run's largest family rises out of the lake. Its
// sealed heads rise one at a time, oldest first; each unfolds into a complete receipt that is readable BEFORE the blind
// stamp; once stamped a problem, only the deck cards whose candidate glows glow in their books, and dragging one onto
// the head answers it. The earlier Open pages rise after the sealed heads. The score inks onto the lake and locks.
// Presentation only: every number is a view field; every act goes through the controller's api.

import './end.css';
import type { BossHeadView, BossView, CardView, ReceiptView, ScreenProps } from '../contract';
import { FILE_OF } from '../contract';
import { Books, Card } from '../cards';
import { ART } from './art';
import { button, el, heron, INERT, receipt, rich, tag } from './dom';
import { bookRows, bossMotion, bossPlan, fmt, newBossMemory, PLATE, plateBox, type BossPlan, type HeadLook } from './model';

/** Presentation memory across repaints (see bossMotion): each animation plays once. */
const seen = newBossMemory();

const FACED_WORD: Record<HeadLook, string> = {
  rising: 'unstamped',
  bared: 'a problem',
  bound: 'addressed',
  standing: 'open',
  heron: 'a change of plan',
  sunk: 'not a problem',
  wrapped: 'unclear',
};

export function BossScreen(p: ScreenProps<BossView>): { stage: HTMLElement; wood: HTMLElement } {
  const v = p.view;
  const ui = p.ui;
  const b = ui.bands;
  const plan = bossPlan(v);
  const cur = plan.current;
  const { rise, ink, bind, inkScore, tear } = bossMotion(seen, plan, ui.effect, ui.reducedMotion);

  // ---------------------------------------------------------------- the stage: the lake at blue hour
  const stageH = b.sky.h + b.creature.h;
  const plate = plateBox(b.viewport, b.shoreY);
  const lakeTop = Math.round(plate.y + PLATE.lake * plate.h - b.sky.y);
  const stage = el('section', `pl-end-boss pl-end-${b.mode}${v.turn === 'summary' ? ' pl-end-settled' : ''}`);
  stage.style.height = `${stageH}px`;
  stage.style.setProperty('--pl-end-lake', `${lakeTop}px`);
  paintPlate(stage, plate, b.sky.y);
  stage.setAttribute('aria-label', plan.title);

  const body = el('img', 'pl-end-body');
  body.src = ART.body(null);
  body.alt = '';
  body.draggable = false;

  const water = el('div', 'pl-end-water');
  paintPlate(water, plate, b.sky.y + lakeTop);

  stage.append(body, facedRow(plan, p, tear), water);
  if (plan.below > 0) stage.append(belowMarks(plan.below));
  if (cur) stage.append(currentHead(cur, plan, v, p, { rise, bind }));
  stage.append(slip(plan, v, p, { rise, ink, inkScore }));
  if (v.turn !== 'summary' && b.mode !== 'phone') stage.append(tally(plan));

  // ---------------------------------------------------------------- the wood: the final deck in its books
  return { stage, wood: wood(v, plan, p) };
}

/** Lay the world plate on a band whose top sits at `top` px in the viewport. */
function paintPlate(node: HTMLElement, plate: { x: number; y: number; w: number; h: number }, top: number): void {
  node.style.backgroundImage = `url("${ART.plate}")`;
  node.style.backgroundSize = `${plate.w}px ${plate.h}px`;
  node.style.backgroundPosition = `${plate.x}px ${plate.y - top}px`;
}

function sprite(src: string, cls: string): HTMLImageElement {
  const i = el('img', cls);
  i.src = src;
  i.alt = '';
  i.draggable = false;
  return i;
}

/** The current head (or an earlier Open page), rising from the water; the answer drag's only target. */
function currentHead(h: BossHeadView, plan: BossPlan, v: BossView, p: ScreenProps<BossView>, f: { rise: boolean; bind: boolean }): HTMLElement {
  const look = plan.look!;
  const drag = p.ui.drag;
  const over = !!drag && drag.target?.kind === 'head' && drag.target.caseId === h.caseId;
  const glow = over ? drag!.preview?.heads.find((x) => x.caseId === h.caseId) : undefined;
  const art = h.source === 'open' ? el('div', 'pl-end-page', el('span', 'pl-end-page-edge')) : look === 'heron' ? heron('pl-end-heronart') : sprite(ART.head(null), 'pl-end-headart');
  const word = over ? (drag!.preview?.refused ?? (glow?.glow ? 'Release to answer this case' : (v.candidates.find((c) => c.cardId === drag!.cardId)?.reason ?? glow?.word ?? null))) : null;
  const node = el(
    'div',
    `pl-end-current pl-end-look-${look}${h.source === 'open' ? ' pl-end-is-page' : ''}${plan.headTarget ? ' pl-end-target' : ''}${over ? ' pl-end-over' : ''}${f.rise ? ' pl-end-rise' : ''}${f.bind ? ' pl-end-bind' : ''}`,
    art,
    look === 'bound' ? el('span', 'pl-end-ribbon') : null,
    tag(h.receipt, 'pl-end-headtag'),
    word ? el('span', `pl-end-word${glow?.glow ? ' pl-end-word-yes' : ''}`, word) : null,
  );
  node.setAttribute('aria-label', h.source === 'open' ? 'An earlier Open page' : 'The current sealed head');
  if (plan.headTarget) p.drag.bindTarget(`head:${h.caseId}:boss`, { kind: 'head', caseId: h.caseId }, node);
  return node;
}

/** Heads already faced, along the water: bound, open, heron, sunk or wrapped. Each opens its receipt in the inspector. */
function facedRow(plan: BossPlan, p: ScreenProps<BossView>, tearing: ReadonlySet<string>): HTMLElement {
  const row = el('div', 'pl-end-faced');
  for (const { head, look } of plan.faced) {
    const tear = tearing.has(head.caseId);
    const art = look === 'heron' ? heron('pl-end-heronart') : head.source === 'open' ? el('div', 'pl-end-page pl-end-page-s') : sprite(ART.head(null), 'pl-end-headart');
    const word = head.disposition === 'unreviewed' ? 'unstamped' : FACED_WORD[look];
    const item = el(
      'button',
      `pl-end-facedhead pl-end-look-${look}${tear ? ' pl-end-tear' : ''}`,
      el('span', 'pl-end-facedart', art, look === 'bound' ? el('span', 'pl-end-ribbon') : null, look === 'standing' ? el('span', 'pl-end-torn') : null),
      el('span', 'pl-end-facedtag', head.receipt.date ?? '', el('b', '', word)),
    );
    item.type = 'button';
    item.title = `${head.receipt.quote ?? 'Tool evidence only'} · ${word}`;
    // A head still unstamped stays sealed to the inspector (the adapter withholds it).
    if (head.disposition === 'unreviewed') item.disabled = true;
    else item.addEventListener('click', () => p.api.inspect({ caseId: head.caseId }));
    row.append(item);
  }
  return row;
}

/** Sealed heads still under the water: wax marks, the view's count, never their words. */
function belowMarks(n: number): HTMLElement {
  const marks = el('span', 'pl-end-seals');
  for (let i = 0; i < Math.min(n, 12); i++) marks.append(el('i', ''));
  return el('div', 'pl-end-below', marks, `${fmt(n)} sealed ${n === 1 ? 'head' : 'heads'} still under the water`);
}

/** The slip: the receipt and the blind stamp, then the answer, the reasons and Continue; at the end, the score. */
function slip(plan: BossPlan, v: BossView, p: ScreenProps<BossView>, f: { rise: boolean; ink: boolean; inkScore: boolean }): HTMLElement {
  const cur = plan.current;
  const s = el('aside', `pl-end-slip${cur ? '' : ' pl-end-scorecard'}${f.rise ? ' pl-end-unfold' : ''}`);
  s.append(el('header', 'pl-end-sliphead', el('h2', 'pl-end-title', plan.title), cur ? el('span', 'pl-end-kicker', cur.source === 'open' ? 'An earlier Open page' : 'A sealed head') : null));

  if (cur) {
    s.append(receipt(cur.receipt));
    if (plan.stamps) {
      const row = el('div', 'pl-end-stamps');
      const buttons = plan.stamps.map((st) =>
        button(`${st.label}`, 'pl-end-stampbtn', () => {
          // The blind stamp locks on click: every stamp goes inert before the controller answers.
          for (const x of buttons) x.disabled = true;
          p.api.boss.stamp(cur.caseId, st.stamp);
        }),
      );
      plan.stamps.forEach((st, i) => buttons[i]!.append(el('kbd', 'pl-end-key', st.key.toUpperCase())));
      row.append(...buttons);
      s.append(row);
    } else if (plan.chosen) {
      s.append(el('div', `pl-end-stamped${f.ink ? ' pl-end-ink' : ''}`, el('span', 'pl-end-stampmark', plan.chosen), el('small', '', cur.source === 'open' ? 'stamped earlier, in its room' : 'stamped blind · locked')));
    }
    if (plan.coach) s.append(el('p', 'pl-end-coach', plan.coach));
    const reading = readingFor(v, plan, p);
    if (reading) s.append(reading);
    if (plan.reasons.length) s.append(reasonsList(plan));
  } else {
    s.append(scoreSheet(plan, f.inkScore));
  }

  const controls = el('div', 'pl-end-controls');
  for (const c of plan.controls) {
    controls.append(
      button(c.label, `pl-end-btn${c.primary ? ' pl-end-primary' : ''}`, () => {
        if (c.act === 'advance') p.api.advance();
        else p.api.boss.next();
      }),
    );
  }
  s.append(controls);
  return s;
}

/** The line a release would accept, at reading size, before the drop: the hovered preview, else the selected card. */
function readingFor(v: BossView, plan: BossPlan, p: ScreenProps<BossView>): HTMLElement | null {
  if (!plan.headTarget) return null;
  const d = p.ui.drag;
  const line = d?.preview?.line ?? null;
  const id = d?.cardId ?? p.ui.selected;
  // Only a glowing card's line can be accepted here; any other card's reason shows on the head instead.
  if (!id || !plan.glow.has(id)) return null;
  const card: CardView | undefined = v.cards.find((c) => c.id === id);
  if (!line && !card) return null;
  const text = line?.text ?? card!.inspector.exact;
  const scope = line?.scope ?? card!.inspector.scope;
  const exceptions = line?.exceptions ?? card!.inspector.exceptions;
  const files = line?.files ?? card!.inFiles.map((a) => FILE_OF[a]);
  return el(
    'div',
    'pl-end-reading',
    el('span', 'pl-end-label', card ? `The line · ${card.face.title}` : 'The line'),
    el('p', 'pl-end-exact', rich(text)),
    el('p', 'pl-end-meta', `${scope}${files.length ? ` · ${files.join(', ')}` : ''}`),
    ...exceptions.map((x) => el('p', 'pl-end-meta', 'except ', rich(x))),
  );
}

function reasonsList(plan: BossPlan): HTMLElement {
  return el(
    'div',
    'pl-end-reasons',
    el('span', 'pl-end-label', 'Each card in your final deck'),
    el('ul', '', ...plan.reasons.map((r) => el('li', '', el('b', '', r.title), r.summary ? el('span', 'pl-end-soft', ' · ', rich(r.summary)) : null, el('span', 'pl-end-why', r.reason)))),
  );
}

/** The score, exactly as printed by the view, with its validity; set-asides beside it and listed by date. */
function scoreSheet(plan: BossPlan, ink: boolean): HTMLElement {
  const sc = plan.score;
  return el(
    'div',
    `pl-end-score pl-end-score-${sc.validity}${ink ? ' pl-end-inkscore' : ''}`,
    el('ol', 'pl-end-lines', ...sc.lines.map((l, i) => {
      const li = el('li', '', l);
      li.style.setProperty('--i', String(i));
      return li;
    })),
    el('p', `pl-end-validity${sc.final ? ' pl-end-final' : ''}`, sc.note),
    plan.setAside.length
      ? el('div', 'pl-end-asides', el('span', 'pl-end-label', 'Set aside'), el('ul', '', ...plan.setAside.map((x) => el('li', '', el('b', '', x.label), ' · ', aside(x.head.receipt)))))
      : null,
  );
}

function aside(r: ReceiptView): HTMLElement {
  return el('span', '', `${r.date ?? 'no date'} · `, r.quote !== null ? el('i', 'pl-end-quote-i', rich(r.quote)) : 'Tool evidence only');
}

/** The live tally beside the heads: the same printed lines, never shown as final. */
function tally(plan: BossPlan): HTMLElement {
  return el('aside', 'pl-end-tally', el('span', 'pl-end-label', plan.score.note), el('ol', 'pl-end-lines', ...plan.score.lines.map((l) => el('li', '', l))));
}

/** The final deck's cards in their books. Only glowing cards glow, and only once the head can be answered. */
function wood(v: BossView, plan: BossPlan, p: ScreenProps<BossView>): HTMLElement {
  const b = p.ui.bands;
  const w = el('div', `pl-end-wood pl-end-${b.mode}`);
  w.style.height = `${b.wood.h}px`;
  paintPlate(w, plateBox(b.viewport, b.shoreY), b.wood.y);
  // The books show their straps; at the boss nothing may drop on a book, so they bind nothing.
  w.append(el('div', 'pl-end-bookprops', Books({ books: v.books, preview: p.ui.drag?.preview ?? null, mode: 'play', layout: b.books.mode, drag: INERT })));
  const deck = el('div', 'pl-end-deck');
  const reason = new Map(v.candidates.map((c) => [c.cardId, c.reason]));
  for (const row of bookRows(v.books, v.cards, plan.glow)) {
    const strip = el('div', 'pl-end-strip');
    for (const c of row.cards) {
      const slot = el(
        'div',
        `pl-end-slot${plan.glow.has(c.id) ? ' pl-end-glow' : plan.dragCards ? ' pl-end-dim' : ''}${p.ui.selected === c.id ? ' pl-end-selected' : ''}`,
        Card({ card: c, size: b.card.size, selected: p.ui.selected === c.id, drag: plan.dragCards ? p.drag : null, onInspect: (id) => p.api.inspect({ cardId: id }) }),
      );
      const why = plan.dragCards ? reason.get(c.id) : null;
      if (why) slot.title = why;
      strip.append(slot);
    }
    deck.append(el('section', 'pl-end-shelfrow', el('h3', 'pl-end-file', row.book.file), row.cards.length ? strip : el('p', 'pl-end-soft', 'No cards in this file.')));
  }
  w.append(deck);
  return w;
}
