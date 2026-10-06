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
import './room.css';

/** "No" to an existing line sends it back for this room; presentation memory only (the act changes nothing). */
const declined = new Set<string>();

function askKey(v: RoomView, a: { cardId: string; caseId: string }): string {
  return `${v.roomKey}|${a.cardId}|${a.caseId}`;
}

function wordingBox(p: ScreenProps<RoomView>): HTMLElement | null {
  const w = p.view.wording;
  if (!w) return null;
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
  const lines = controlLines(v);
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
  return el('div', 'pl-room-controls', row, ...lines.map((l) => el('p', 'pl-room-line', l)));
}

/** The beast's height: the creature band, or less when the arena is narrow (presentation maths). */
function beastHeight(p: ScreenProps<RoomView>, arenaW: number, arenaH: number): number {
  const rig = RIGS[p.view.beast.skin];
  const sockets = p.view.beast.heads.map((h) => h.socket ?? -1);
  const fit = fitRig(rig, sockets, arenaH, arenaW);
  return Math.max(60, Math.min(arenaH, Math.round(fit.h / rig.fill)));
}

function compose(p: ScreenProps<RoomView>, event: boolean): HTMLElement {
  const v = p.view;
  const b = p.ui.bands;
  const stageH = Math.max(0, b.shoreY - (b.header.y + b.header.h));
  const phone = b.mode === 'phone';
  const judging = v.phase === 'judge' && v.review.remaining > 0;
  const root = el('section', `pl-room${phone ? ' is-phone' : ''}${p.ui.reducedMotion ? ' is-reduced' : ''}${event ? ' is-event' : ''} is-${v.kind}`);
  root.style.height = `${stageH}px`;
  root.dataset.room = v.roomKey;

  const sideW = phone ? b.viewport.w - 32 : Math.min(380, Math.max(280, Math.round(b.viewport.w * 0.28)));
  const arenaW = phone ? b.viewport.w - 32 : b.viewport.w - sideW - 48 - 16;
  // Phones: while heads wait for stamps the slip takes most of the stage; afterwards the beast does.
  const arenaH = phone ? Math.round(stageH * (judging ? 0.36 : 0.62)) : stageH - 10;

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
    height: beastHeight(p, arenaW, arenaH),
    drag: p.drag,
    onHead: (id) => {
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
  const side = el('div', 'pl-room-side', ReceiptStage({ room: v, api: p.api }), askBox(p), wordingBox(p), controlsBox(p));
  if (!phone) side.style.width = `${sideW}px`;
  side.style.maxHeight = `${phone ? stageH - arenaH - 8 : stageH - 10}px`;
  root.append(side, arena);
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
