// Owner: room/rig. The receipt slip (§0a.13): one complete receipt at a time on the stage, with the queue visible and
// immediate advance. The four stamps come from STAMPS; their keys (A, C, N, U) are the controller's and are only
// shown here, never bound again. A dealt hand keeps the stamps visible but waiting: pull the hand back to change one.
import type { ControllerApi, HeadView, ReceiptView, RoomView } from '../contract';
import { COPY, STAMPS } from '../contract';
import { agentName, button, codeText, el, sigil } from './dom';
import { ringsText, shortDate } from './logic';
import { flush } from './motion';
import './room.css';

const STAMP_WORD: Record<string, string> = { issue: 'A problem', pivot: 'A change of plan', 'not-a-problem': 'Not a problem', unclear: 'Unclear · leave wrapped' };

/** The current head's full tag (agent, project, date): the slip carries it whenever the beast shows compact tags. */
function tagLine(h: HeadView | undefined, r: ReceiptView): HTMLElement {
  const tag = h?.tag ?? { agent: r.agent, project: r.project, date: r.date };
  return el(
    'div',
    'pl-room-slip-tag',
    el('span', 'pl-room-chip is-agent', sigil(tag.agent, 16), agentName(tag.agent)),
    tag.project ? el('span', 'pl-room-chip is-project', tag.project) : null,
    tag.date ? el('span', 'pl-room-chip is-date', tag.date) : null,
  );
}

function headMark(h: HeadView): string {
  switch (h.state) {
    case 'wrapped':
      return h.disposition === 'unclear' ? 'unclear' : 'to read';
    case 'lantern':
      return 'verified';
    default:
      return STAMP_WORD[h.disposition] ?? h.disposition;
  }
}

/** One complete receipt at a time with a visible queue and immediate advance; the four stamps (§0a.6, §0a.13). */
export function ReceiptStage(p: { room: RoomView; api: ControllerApi }): HTMLElement {
  const v = p.room;
  const r = v.receipts.current;
  const root = el('section', 'pl-room-slip');
  root.setAttribute('aria-label', 'Receipt');
  if (!r) {
    root.append(el('p', 'pl-room-slip-empty', 'No receipt to read in this room.'));
    return root;
  }
  const head = v.heads.find((h) => h.caseId === r.caseId);
  const workshop = v.kind === 'workshop';
  const { position, total } = v.receipts.progress;
  const headRow = el('header', 'pl-room-slip-head', el('span', 'pl-room-slip-count', workshop ? `Session ${position} of ${total}` : `Receipt ${position} of ${total}`));
  root.append(
    headRow,
    tagLine(head, r),
    r.quote
      ? el('blockquote', 'pl-room-quote', '“', codeText(r.quote), '”', r.pasted ? el('small', 'pl-room-pasted', ' pasted') : null)
      : el('p', 'pl-room-noquote', 'Tool evidence only'),
  );
  const act = el('div', 'pl-room-act');
  if (r.action) act.append(el('div', 'pl-room-act-line', el('span', 'pl-room-act-k', 'did'), el('span', 'pl-room-mono', codeText(r.action))));
  if (r.result) act.append(el('div', 'pl-room-act-line', el('span', 'pl-room-act-k', '→'), el('span', 'pl-room-mono', codeText(r.result))));
  if (r.then) act.append(el('div', 'pl-room-act-line', el('span', 'pl-room-act-k', 'then'), el('span', 'pl-room-mono', codeText(r.then))));
  if (act.childNodes.length) root.append(act);
  if (head?.rings) root.append(el('p', 'pl-room-rings-line', `Neck rings: ${ringsText(head.rings)} in this session`));

  if (workshop || head?.state === 'lantern') {
    root.append(el('p', 'pl-room-slip-note', 'A verified session. Lanterns are not stamped and count nowhere.'));
  } else {
    const live = v.phase === 'judge';
    const stamps = el('div', 'pl-room-stamps');
    stamps.setAttribute('role', 'group');
    stamps.setAttribute('aria-label', 'Stamp this case');
    for (const s of STAMPS) {
      const on = head?.disposition === s.stamp;
      const b = button(
        `pl-room-stamp is-${s.stamp}${on ? ' is-on' : ''}`,
        el('span', 'pl-room-stamp-label', s.label),
        () => {
          flush();
          p.api.stamp(r.caseId, s.stamp);
        },
        { disabled: !live, pressed: on, aria: `${s.label} (key ${s.key.toUpperCase()})` },
      );
      b.append(el('kbd', 'pl-room-key', s.key.toUpperCase()));
      stamps.append(b);
    }
    root.append(stamps);
    if (!live && v.phase === 'dealt') root.append(el('p', 'pl-room-slip-note', COPY.pullBack));
  }

  // The queue, beside the count so it never scrolls away: every head in the room (overflow heads included), the current
  // one marked; any head can be read next.
  if (v.heads.length > 1) {
    const q = el('nav', 'pl-room-queue');
    q.setAttribute('aria-label', 'Heads in this room');
    for (const h of v.heads) {
      const cur = h.caseId === r.caseId;
      const label = `${agentName(h.tag.agent)}${h.tag.project ? ` · ${h.tag.project}` : ''}${h.tag.date ? ` · ${h.tag.date}` : ''} · ${headMark(h)}`;
      const b = button(
        `pl-room-qchip is-${h.state}${cur ? ' is-current' : ''}`,
        null,
        () => {
          flush();
          p.api.focusReceipt(h.caseId);
        },
        { aria: label, pressed: cur },
      );
      b.append(sigil(h.tag.agent, 14), el('span', 'pl-room-qdate', shortDate(h.tag.date) ?? '·'), el('span', 'pl-room-qmark', ''));
      b.title = label;
      q.append(b);
    }
    headRow.append(q);
  }
  return root;
}
