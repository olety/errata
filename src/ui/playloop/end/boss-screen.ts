// Owner: boss/apply. The boss (play-loop §9, §0a.12): at blue hour the run's largest family rises out of the lake. Its
// sealed heads rise one at a time, oldest first; each unfolds into a complete receipt that is readable BEFORE the blind
// stamp; once stamped a problem, only the deck cards whose candidate glows glow in their books, and dragging one onto
// the head answers it. The earlier Open pages rise after the sealed heads. The score inks onto the lake and locks.
// Presentation only: every number is a view field; every act goes through the controller's api.

import './end.css';
import type { BossHeadView, BossView, CardView, ReceiptView, ScreenProps } from '../contract';
import { FILE_OF } from '../contract';
import { Books, Card, icon, iconSvg, info, tip, type IconName } from '../cards';
import { ART } from './art';
import { button, el, heron, INERT, linkedLine, receipt, rich, splitLabel, tag } from './dom';
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
  body.src = ART.body(v.skin);
  body.alt = '';
  body.draggable = false;

  const water = el('div', 'pl-end-water');
  paintPlate(water, plate, b.sky.y + lakeTop);

  stage.append(body, facedRow(plan, p, tear), water);
  if (plan.below > 0) stage.append(belowMarks(plan.below));
  if (cur) stage.append(currentHead(cur, plan, v, p, { rise, bind }));
  stage.append(slip(plan, v, p, { rise, ink, inkScore }));
  if (v.turn !== 'summary' && b.mode !== 'phone') stage.append(tally(plan, p));

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
  const art = h.source === 'open' ? el('div', 'pl-end-page', el('span', 'pl-end-page-edge')) : look === 'heron' ? heron('pl-end-heronart') : sprite(ART.head(v.skin), 'pl-end-headart');
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
    const art = look === 'heron' ? heron('pl-end-heronart') : head.source === 'open' ? el('div', 'pl-end-page pl-end-page-s') : sprite(ART.head(p.view.skin), 'pl-end-headart');
    const word = head.disposition === 'unreviewed' ? 'unstamped' : FACED_WORD[look];
    const item = el(
      'button',
      `pl-end-facedhead pl-end-look-${look}${tear ? ' pl-end-tear' : ''}`,
      el('span', 'pl-end-facedart', art, look === 'bound' ? el('span', 'pl-end-ribbon') : null, look === 'standing' ? el('span', 'pl-end-torn') : null),
      el('span', 'pl-end-facedtag', head.receipt.date ?? '', el('b', '', word)),
    );
    item.type = 'button';
    tip(item, `${head.receipt.quote ?? 'Tool evidence only'} · ${word}`);
    // A head still unstamped stays sealed to the inspector (the adapter withholds it).
    if (head.disposition === 'unreviewed') item.disabled = true;
    else item.addEventListener('click', () => p.api.inspect({ caseId: head.caseId }));
    row.append(item);
  }
  return row;
}

/** Sealed heads still under the water: wax marks, the view's count, never their words; the sentence in the tooltip. */
function belowMarks(n: number): HTMLElement {
  const marks = el('span', 'pl-end-seals');
  marks.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < Math.min(n, 12); i++) marks.append(el('i', ''));
  const said = `${fmt(n)} more sealed ${n === 1 ? 'head' : 'heads'} under the water, after this one`;
  const row = el('div', 'pl-end-below', marks, `${fmt(n)} more`);
  row.tabIndex = 0;
  row.setAttribute('aria-label', said);
  return tip(row, said);
}

/** The slip: the receipt and the blind stamp, then the answer, the reasons and Continue; at the end, the score. */
function slip(plan: BossPlan, v: BossView, p: ScreenProps<BossView>, f: { rise: boolean; ink: boolean; inkScore: boolean }): HTMLElement {
  const cur = plan.current;
  const s = el('aside', `pl-end-slip${cur ? '' : ' pl-end-scorecard'}${f.rise ? ' pl-end-unfold' : ''}`);
  s.append(el('header', 'pl-end-sliphead', el('h2', 'pl-end-title', plan.title), cur ? el('span', 'pl-end-kicker', cur.source === 'open' ? icon('book', 'An earlier Open page') : icon('seal', 'A sealed head')) : null));

  if (cur) {
    s.append(receipt(cur.receipt));
    if (plan.stamps) {
      const row = el('div', 'pl-end-stamps');
      // Stamp marks, as on the room's slip (text-density pass, R9): a small ink drawing and the word; the letter key
      // and the full label sit in the tooltip and the aria-label.
      const MARK: Record<string, [IconName, string]> = { issue: ['cross', 'A problem'], pivot: ['bend', 'A change of plan'], 'not-a-problem': ['tick', 'Not a problem'], unclear: ['question', 'Unclear'] };
      const buttons = plan.stamps.map((st) => {
        const [ic, word] = MARK[st.stamp] ?? ['question', st.label];
        const b = button('', 'pl-end-stampbtn pl-end-stampmarkbtn', () => {
          // The blind stamp locks on click: every stamp goes inert before the controller answers.
          for (const x of buttons) x.disabled = true;
          p.api.boss.stamp(cur.caseId, st.stamp);
        });
        b.append(iconSvg(ic), el('span', 'pl-end-stampword', word));
        b.setAttribute('aria-label', `${st.label} (key ${st.key.toUpperCase()})`);
        tip(b, `${st.label} · key ${st.key.toUpperCase()}`);
        return b;
      });
      row.append(...buttons);
      s.append(row);
    } else if (plan.chosen) {
      const how = cur.source === 'open' ? icon('clock', 'Stamped earlier, in its room') : icon('lock', 'Stamped blind · locked');
      s.append(el('div', `pl-end-stamped${f.ink ? ' pl-end-ink' : ''}`, el('span', 'pl-end-stampmark', plan.chosen), how));
    }
    // The table's coach line (the sample's tutorial) already names the gesture: the slip says it only when that is off.
    if (plan.coach && !p.ui.tutorial) s.append(el('p', 'pl-end-coach', plan.hint ?? plan.coach, plan.hint && plan.hint !== plan.coach ? info('About this step', plan.coach) : null));
    const reading = readingFor(v, plan, p);
    if (reading) s.append(reading);
    if (plan.reasons.length) s.append(reasonsList(plan));
  } else {
    s.append(scoreSheet(plan, f.inkScore, p));
  }

  const controls = el('div', 'pl-end-controls');
  for (const c of plan.controls) {
    // R6: the verb on the button ("Continue"), the rest ("leave it open") in its tooltip.
    const [verb, more] = splitLabel(c.label);
    const btn = button(verb, `pl-end-btn${c.primary ? ' pl-end-primary' : ''}`, () => {
      if (c.act === 'advance') p.api.advance();
      else p.api.boss.next();
    });
    if (more) tip(btn, more);
    controls.append(btn);
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

/**
 * The tally as short rows (a number with its unit, one icon each) and one (i) whose note holds the printed lines, every
 * not-yet-judged excerpt still a link to its inspector row.
 */
function tallyBody(plan: BossPlan, p: ScreenProps<BossView>): { head: HTMLElement; rows: HTMLElement } {
  const sc = plan.score;
  const open = (cardId: string) => p.api.inspect({ cardId });
  const printed = sc.lines.map((l) => el('p', '', ...linkedLine(l, sc.unjudged, open)));
  const more = info('About the tally', sc.note, { title: sc.head, body: [sc.note, ...printed] });
  const rows = el(
    'ul',
    'pl-end-lines pl-end-rows',
    ...sc.rows.map((r, i) => {
      const unjudged = r.link ? sc.unjudged.find((u) => u.cardId === r.link) : undefined;
      let text: Node = document.createTextNode(r.text);
      if (r.link) {
        const b = button(r.text, 'pl-end-link', () => open(r.link!));
        tip(b, `'${unjudged?.excerpt ?? ''}' · open it to judge`);
        text = b;
      }
      const li = el('li', 'pl-end-row', iconSvg(r.icon), text);
      li.style.setProperty('--i', String(i));
      return li;
    }),
  );
  return { head: el('span', 'pl-end-label pl-end-tallyhead', sc.head, more), rows };
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
function scoreSheet(plan: BossPlan, ink: boolean, p: ScreenProps<BossView>): HTMLElement {
  const sc = plan.score;
  const t = tallyBody(plan, p);
  t.head.className = `pl-end-validity${sc.final ? ' pl-end-final' : ''}`;
  return el(
    'div',
    `pl-end-score pl-end-score-${sc.validity}${ink ? ' pl-end-inkscore' : ''}`,
    t.rows,
    t.head,
    plan.setAside.length
      ? el('div', 'pl-end-asides', el('span', 'pl-end-label', 'Set aside'), el('ul', '', ...plan.setAside.map((x) => el('li', '', el('b', '', x.label), ' · ', aside(x.head.receipt)))))
      : null,
  );
}

function aside(r: ReceiptView): HTMLElement {
  return el('span', '', `${r.date ?? 'no date'} · `, r.quote !== null ? el('i', 'pl-end-quote-i', rich(r.quote)) : 'Tool evidence only');
}

/** The live tally beside the heads: short rows, the printed lines behind its (i), never shown as final. */
function tally(plan: BossPlan, p: ScreenProps<BossView>): HTMLElement {
  const t = tallyBody(plan, p);
  return el('aside', 'pl-end-tally', t.head, t.rows);
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
  // The strip scrolls sideways under a vertical wheel too (its scrollbar is hidden to keep the Inspect tabs in the wood).
  deck.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      deck.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );
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
      if (why) tip(slot, why);
      // Say it in words as well as in light: which cards can answer this case, and why the others cannot.
      if (plan.dragCards) {
        const card = slot.querySelector<HTMLElement>('[data-card]');
        const label = card?.getAttribute('aria-label') ?? '';
        if (card) card.setAttribute('aria-label', plan.glow.has(c.id) ? `Glows: can answer this case. ${label}` : `${label}${why ? ` Cannot answer this case: ${why}.` : ''}`);
        if (plan.glow.has(c.id)) slot.append(el('span', 'pl-end-glowtag', icon('target', 'Can answer', 'Can answer this case')));
      }
      strip.append(slot);
    }
    deck.append(el('section', 'pl-end-shelfrow', el('h3', 'pl-end-file', row.book.file), row.cards.length ? strip : el('p', 'pl-end-soft', 'No cards in this file.')));
  }
  w.append(deck);
  return w;
}
