// Owner: room/rig. The room's stage band (§2, §0a.13–14): the beast, one receipt at a time with the stamps, and the
// room controls (Deal, Pull the hand back, Continue or Keep existing, Skip when it is the only way out, "Already in
// your file?"). The mount puts it in the Table's stage band and builds the wood from the cards worker's Hand, Books and
// Piles. Rise → Judge → Deal → Play → Strike → Clear come from ui.beat; nothing waits on an animation.
import type { RoomView, ScreenProps } from '../contract';
import { Beast, type BeastCues } from './beast';
import { button, codeText, el } from './dom';
import { clearOf, controlLines, foldCues, roomControls, strikeCues } from './logic';
import { flush } from './motion';
import { RIGS, fitRig } from './rig';
import { ReceiptStage } from './stage';
import { icon, iconSvg, info, tip } from '../cards';
import './room.css';

/** "No" to an existing line sends it back for this room; presentation memory only (the act changes nothing). */
const declined = new Set<string>();

function askKey(v: RoomView, a: { cardId: string; caseId: string }): string {
  return `${v.roomKey}|${a.cardId}|${a.caseId}`;
}

/** Rooms whose wording box the player opened (presentation memory across repaints). */
const wordingOpen = new Set<string>();

/**
 * "Your wording" (text-density pass, R11): a quill button; the textarea opens on click with the current line prefilled.
 */
function wordingBox(p: ScreenProps<RoomView>): HTMLElement | null {
  const w = p.view.wording;
  if (!w) return null;
  const key = p.view.roomKey;
  if (!wordingOpen.has(key)) {
    const b = button('pl-room-btn pl-room-quill', null, () => {
      wordingOpen.add(key);
      p.api.wording(key, w.value);
    }, { aria: w.editable ? 'Your wording: change the line in your own words before you deal' : 'Your wording: read the line' });
    b.append(iconSvg('quill'), w.editable ? ' Your wording' : ' The wording');
    tip(b, w.editable ? 'The line, in your words (before you deal)' : 'The line, in your words');
    return el('div', 'pl-room-wording', b);
  }
  const id = `pl-room-wording-${p.view.roomKey}`;
  const ta = el('textarea', '');
  ta.id = id;
  ta.value = w.value;
  ta.readOnly = !w.editable;
  ta.rows = 2;
  // Commit on change (blur), never per keystroke: every commit repaints the stage.
  ta.addEventListener('change', () => p.api.wording(p.view.roomKey, ta.value));
  const label = el('label', '', w.editable ? 'The line, in your words (before you deal)' : 'The line, in your words');
  label.htmlFor = id;
  return el('div', 'pl-room-wording', label, ta);
}

/**
 * The scope chip (check 4): "all projects" or one project. While judging, a room whose heads span projects lets the
 * player confirm one; the drafts then name it, and heads from other projects turn aside with their project's name.
 */
function scopeBox(p: ScreenProps<RoomView>): HTMLElement | null {
  const s = p.view.scope;
  // A globe for all projects, a folder for one (text-density pass, R11); what the scope means sits behind the (i).
  const global = !s.confirmed || /^all projects$/i.test(s.chip);
  const chip = el('span', 'pl-room-scope-chip', icon(global ? 'globe' : 'folder', global ? 'All projects' : 'This project', undefined, false), ` ${s.chip}`);
  const more = s.confirmable ? [`Seen in ${s.projects.map((x) => x.label).join(' and ')}. The line applies to all projects unless you confirm one.`, ...(s.hint ? [s.hint] : [])] : ['The projects this line applies to.'];
  const head = el('p', 'pl-room-scope', el('span', 'pl-room-scope-k', 'Scope'), chip, info('About the scope', more[0]!, { title: 'Scope', body: more }));
  if (s.hint) chip.classList.add('is-warn');
  if (!s.confirmable) return el('div', 'pl-room-scopebox', head);
  const pick = (key: string | null, label: string) => {
    const on = (s.confirmed?.key ?? null) === key;
    const b = button(`pl-room-btn pl-room-scope-btn${on ? ' is-on' : ''}`, label, () => {
      flush();
      p.api.confirmProject(p.view.roomKey, key);
    });
    b.setAttribute('aria-pressed', String(on));
    return b;
  };
  return el(
    'div',
    'pl-room-scopebox',
    head,
    el('div', 'pl-room-buttons pl-room-scope-row', pick(null, 'All projects'), ...s.projects.map((x) => pick(x.key, `Only ${x.label}`))),
  );
}

function askBox(p: ScreenProps<RoomView>): HTMLElement | null {
  const v = p.view;
  const a = v.existingAsks.find((x) => !declined.has(askKey(v, x)));
  if (!a) return null;
  const files = a.reading.files.join(' and ');
  return el(
    'section',
    'pl-room-ask',
    el('h3', '', 'Already in your file. Does it answer this case?'),
    el('p', 'pl-room-reading', codeText(a.reading.text)),
    el('p', 'pl-room-reading-meta', `Scope: ${a.reading.scope}${a.reading.exceptions.length ? ` · Except: ${a.reading.exceptions.join('; ')}` : ''}${files ? ` · In ${files}` : ''}`),
    el(
      'div',
      'pl-room-buttons',
      button('pl-room-btn is-primary', 'Yes', () => {
        flush();
        p.api.answerExisting(a.cardId, a.caseId, true);
      }),
      button('pl-room-btn', 'No', () => {
        declined.add(askKey(v, a));
        p.api.answerExisting(a.cardId, a.caseId, false);
      }),
    ),
  );
}

function controlsBox(p: ScreenProps<RoomView>): HTMLElement | null {
  const v = p.view;
  const cs = roomControls(v);
  // After the play: what the room now has, and that nothing lands before Apply (P3 gate fix 4).
  const lines = [...(v.clear ? [v.clear] : []), ...(v.handDiffers ? [v.handDiffers] : []), ...controlLines(v)];
  void lines;
  if (!cs.length && !lines.length) return null;
  const act: Record<string, () => void> = {
    deal: () => p.api.deal(),
    'pull-back': () => p.api.pullBack(),
    continue: () => p.api.advance(),
    'keep-existing': () => p.api.advance(),
    skip: () => p.api.skip(),
  };
  const row = el('div', 'pl-room-buttons');
  const whys = new Set<string>();
  cs.forEach((c, i) => {
    row.append(
      button(`pl-room-btn${i === 0 && c.enabled ? ' is-primary' : ''}`, c.label, () => {
        flush();
        act[c.id]!();
      }, { disabled: !c.enabled }),
    );
    if (c.why) whys.add(c.why);
  });
  for (const w of whys) row.append(el('span', 'pl-room-why', w));
  // The finalizes line, the pull-back hint and how a hand differs sit behind one (i) beside the buttons (R6).
  const notes = [...(v.handDiffers ? [v.handDiffers] : []), ...controlLines(v)];
  if (notes.length) row.append(info(cs[0]?.label ? `About ${cs[0].label}` : 'About this step', notes[0]!, { title: cs[0]?.label ?? 'This step', body: notes }));
  // Phones (the flow): the hand lies below the beast, so the selected card's tap target is also here, the same act as a
  // tap on the beast (tap–tap, §0a.15), with its reading already on the books' page.
  const sel = p.ui.selected ? v.hand.find((c) => c.id === p.ui.selected) : undefined;
  if (p.ui.bands.flow && v.phase === 'dealt' && sel) {
    row.prepend(
      button('pl-room-btn is-primary', `Play “${sel.face.title}” on the beast`, () => {
        flush();
        p.api.tapTarget({ kind: 'beast' });
      }),
    );
  }
  // After a play the clear line keeps its first sentence on screen ("3 cases now have a proposed line"); the rest,
  // that nothing is written before Apply, is its (i).
  const clear = v.clear ? el('p', 'pl-room-line pl-room-clear', v.clear.split('. ')[0]!.replace(/\.$/, ''), ' ', info('About this play', v.clear)) : null;
  return el('div', 'pl-room-controls', row, clear);
}

/** The beast's height: the creature band, or less when the arena is narrow (presentation maths). */
function beastHeight(p: ScreenProps<RoomView>, arenaW: number, arenaH: number): number {
  const rig = RIGS[p.view.beast.skin];
  const sockets = p.view.beast.heads.map((h) => h.socket ?? -1);
  const fit = fitRig(rig, sockets, arenaH, arenaW);
  return Math.max(60, Math.min(arenaH, Math.round(fit.h / rig.fill)));
}

/** Column widths per mode (presentation maths): the slip on the left, the controls rail on the right. */
export function stageColumns(mode: 'desktop' | 'tablet' | 'phone', viewportW: number): { side: number; rail: number; arena: number; pad: number; gap: number } {
  if (mode === 'phone') return { side: viewportW - 32, rail: viewportW - 32, arena: viewportW - 32, pad: 16, gap: 8 };
  const pad = mode === 'desktop' ? 24 : 16;
  const gap = mode === 'desktop' ? 20 : 12;
  const side = mode === 'desktop' ? Math.min(380, Math.max(320, Math.round(viewportW * 0.26))) : 292;
  const rail = mode === 'desktop' ? 250 : 210;
  return { side, rail, arena: Math.max(200, viewportW - 2 * pad - side - rail - 2 * gap), pad, gap };
}

/** Room for the pips label above the beast's crown. */
const PIPS_H = 30;

function compose(p: ScreenProps<RoomView>, event: boolean): HTMLElement {
  const v = p.view;
  const b = p.ui.bands;
  const stageH = Math.max(0, b.shoreY - (b.header.y + b.header.h));
  const phone = b.mode === 'phone';
  const judging = v.phase === 'judge' && v.review.remaining > 0;
  const cols = stageColumns(b.mode, b.viewport.w);
  const root = el('section', `pl-room is-${b.mode}${p.ui.reducedMotion ? ' is-reduced' : ''}${event ? ' is-event' : ''}${judging ? ' is-judging' : ''} is-${v.kind}${b.flow ? ' is-flow' : ''}`);
  // In the flow (phones below 500 px) the room is as tall as its content and the page scrolls (P3 gate fix F).
  if (!b.flow) root.style.height = `${stageH}px`;
  root.style.setProperty('--pl-room-pad', `${cols.pad}px`);
  root.style.setProperty('--pl-room-gap', `${cols.gap}px`);
  root.dataset.room = v.roomKey;

  // Phones: while heads wait for stamps the slip takes most of the stage; afterwards the beast does.
  const arenaH = b.flow ? Math.min(300, Math.max(220, Math.round(b.viewport.h * 0.32))) : phone ? Math.round(stageH * (judging ? 0.32 : 0.6)) : stageH - 8;

  const glow = new Map((p.ui.drag?.preview?.heads ?? []).map((h) => [h.caseId, h]));
  const cues: BeastCues = {
    fold: foldCues(v, p.ui.effect),
    strike: strikeCues(v, p.ui.beat),
    roomKey: v.roomKey,
    phase: v.phase,
    leanTo: p.ui.drag ? `${p.ui.drag.cardId}|${JSON.stringify(p.ui.drag.target)}` : null,
    clear: clearOf(v),
    resultId: v.result?.id ?? null,
    focused: v.receipts.current?.caseId ?? null,
  };
  const beast = Beast({
    beast: v.beast,
    glow,
    beat: p.ui.beat,
    reducedMotion: p.ui.reducedMotion,
    height: beastHeight(p, cols.arena, arenaH - PIPS_H),
    width: cols.arena,
    drag: p.drag,
    // With a card selected, a tap on a head is the drop (tap–tap); only an idle tap reads the head's receipt.
    onHead: (id) => {
      if (p.ui.selected) return;
      flush();
      p.api.focusReceipt(id);
    },
    cues,
  });
  // The "+N" knot fans the rest of the slips: it opens the first head behind it.
  const rest = v.heads.find((h) => h.socket === null);
  const knot = beast.querySelector<HTMLButtonElement>('.pl-room-knot');
  if (knot && rest) knot.addEventListener('click', () => p.api.focusReceipt(rest.caseId));

  const arena = el('div', 'pl-room-arena', beast);
  arena.style.height = `${arenaH}px`;
  if (!phone) arena.style.width = `${cols.arena}px`;
  // While heads wait for stamps (desktop and tablet) the slip leaves the side column for the centre of the table, under
  // the beast, larger: it is the one thing to read. After the deal it returns to the side.
  const center = judging && !phone;
  const side = el('div', `pl-room-side${center ? ' is-center' : ''}`, ReceiptStage({ room: v, api: p.api, speech: center }));
  if (phone) {
    // One scroller under the beast: slip, prompt, wording, then the controls, which stick to its bottom edge once
    // judging is done (while heads wait for stamps the slip needs the room).
    const scroller = el('div', 'pl-room-scroll', side, askBox(p), scopeBox(p), wordingBox(p), controlsBox(p));
    if (!b.flow) scroller.style.height = `${Math.max(0, stageH - arenaH - cols.gap)}px`;
    root.append(arena, scroller);
  } else {
    const rail = el('div', 'pl-room-rail', askBox(p), scopeBox(p), wordingBox(p), controlsBox(p));
    rail.style.width = `${cols.rail}px`;
    rail.style.maxHeight = `${stageH - 8}px`;
    if (center) {
      // A spacer keeps the beast where it stands; the slip sits centred on the shore line and the wood below it.
      const spacer = el('div', 'pl-room-spacer');
      spacer.style.width = `${cols.side}px`;
      side.style.width = `${Math.min(720, b.viewport.w - 2 * cols.pad - 2 * 200)}px`;
      side.style.top = `${Math.round(stageH * 0.74)}px`;
      side.style.maxHeight = `${Math.max(240, b.viewport.h - (b.header.y + b.header.h) - Math.round(stageH * 0.74) - 64)}px`;
      root.append(spacer, arena, rail, side);
    } else {
      side.style.width = `${cols.side}px`;
      side.style.maxHeight = `${stageH - 8}px`;
      root.append(side, arena, rail);
    }
  }
  return root;
}

export function RoomScreen(p: ScreenProps<RoomView>): HTMLElement {
  return compose(p, false);
}

/**
 * The Event (§8): a paper heron on the shore with its slip. "A change of plan" lets it fly off (listed at the end,
 * counts nowhere); "A problem" turns it into a one-head room on the spot (the adapter then serves a room view, and the
 * heron stays as its one head).
 */
export function EventScreen(p: ScreenProps<RoomView>): HTMLElement {
  return compose(p, true);
}
