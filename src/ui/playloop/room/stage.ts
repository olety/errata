// Owner: room/rig. The receipt slip (§0a.13): one complete receipt at a time on the stage, with the queue visible and
// immediate advance. The four stamps come from STAMPS; their keys (A, C, N, U) are the controller's and are only
// shown here, never bound again. A dealt hand keeps the stamps visible but waiting: pull the hand back to change one.
import type { ControllerApi, HeadView, ReceiptView, RoomView } from '../contract';
import { COPY, STAMPS } from '../contract';
import { agentName, button, codeText, el, sigil } from './dom';
import { ringsText, shortDate } from './logic';
import { flush } from './motion';
import { iconSvg, info, tip, type IconName } from '../cards';
import './room.css';

const STAMP_WORD: Record<string, string> = { issue: 'A problem', pivot: 'A change of plan', 'not-a-problem': 'Not a problem', unclear: 'Unclear · leave wrapped' };

/** The stamp marks (text-density pass, R9): a small ink drawing per stamp, the word under it; the key in the tooltip. */
const STAMP_MARK: Record<string, { icon: IconName; word: string }> = {
  issue: { icon: 'cross', word: 'A problem' },
  pivot: { icon: 'bend', word: 'A change of plan' },
  'not-a-problem': { icon: 'tick', word: 'Not a problem' },
  unclear: { icon: 'question', word: 'Unclear' },
};

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

/**
 * "Stamp the rest like this one": offered after at least one head is stamped while others still wait. The stamp is the
 * one the player gave most recently (the last stamped head in the queue order that is not wrapped by "unclear").
 */
function stampedLike(v: RoomView): { stamp: Exclude<HeadView['disposition'], 'unreviewed'>; ids: string[] } | null {
  const waiting = v.heads.filter((h) => h.disposition === 'unreviewed').map((h) => h.caseId);
  const done = v.heads.filter((h) => h.disposition !== 'unreviewed');
  if (waiting.length === 0 || done.length === 0) return null;
  const d = done[done.length - 1]!.disposition as Exclude<HeadView['disposition'], 'unreviewed'>;
  return { stamp: d, ids: waiting };
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
  // What came after the repeats (it broke the loop), never between them: say so (cold run 2: read as "changed").
  if (r.then) act.append(el('div', 'pl-room-act-line', el('span', 'pl-room-act-k', head?.rings ? 'after the repeats' : 'then'), el('span', 'pl-room-mono', codeText(r.then))));
  if (act.childNodes.length) root.append(act);
  // The rings are evidence, never the beast's health: say what they count first (cold run 2: read as HP).
  // Text-density pass: the count with its unit on the slip; the sentence in the tooltip and behind the (i).
  if (head?.rings) {
    const runs = head.rings.counts === 'failed runs';
    const why = runs ? `In this session the same command ran ${head.rings.count} times unchanged and failed each time (one ring on the neck per failed run).` : `In this session the same file was edited ${head.rings.count} times (one ring on the neck per edit).`;
    root.append(el('p', 'pl-room-rings-line', iconSvg('repeat'), ` ${head.rings.count} ${runs ? 'failed runs' : 'edits'} `, info('About the rings', why)));
  }

  if (workshop || head?.state === 'lantern') {
    root.append(el('p', 'pl-room-slip-note', 'A verified session. ', info('About lanterns', 'Lanterns are not stamped and count nowhere.')));
  } else {
    const live = v.phase === 'judge';
    const stamps = el('div', 'pl-room-stamps');
    stamps.setAttribute('role', 'group');
    stamps.setAttribute('aria-label', 'Stamp this case');
    for (const s of STAMPS) {
      const on = head?.disposition === s.stamp;
      const mark = STAMP_MARK[s.stamp] ?? { icon: 'question' as IconName, word: s.label };
      const b = button(
        `pl-room-stamp pl-room-stampmark is-${s.stamp}${on ? ' is-on' : ''}`,
        el('span', 'pl-room-stamp-label', iconSvg(mark.icon), el('span', 'pl-room-stamp-word', mark.word)),
        () => {
          flush();
          p.api.stamp(r.caseId, s.stamp);
        },
        { disabled: !live, pressed: on, aria: `${s.label} (key ${s.key.toUpperCase()})` },
      );
      tip(b, `${s.label} · key ${s.key.toUpperCase()}`);
      stamps.append(b);
    }
    root.append(stamps);
    // After the first stamp, a secondary control stamps each remaining head the same way, one act per head, each
    // re-stampable from the queue (P3 gate fix G). It is offered only once the player has read and stamped one.
    const last = stampedLike(v);
    if (live && last) {
      const word = STAMP_WORD[last.stamp] ?? last.stamp;
      const rest = button(
        'pl-room-btn pl-room-rest',
        `Stamp ${last.ids.length} more “${word}”`,
        () => {
          flush();
          for (const id of last.ids) p.api.stamp(id, last.stamp);
        },
        { aria: `Stamp the ${last.ids.length} unstamped heads ${word}, each one on its own; any of them can be stamped again from the queue` },
      );
      tip(rest, `Stamp the ${last.ids.length} still waiting “${word}”, like the last one`);
      root.append(rest);
    }
    // While dealt the stamps wait; "Pull the hand back" (on the rail) says why behind its (i).
    if (!live && v.phase === 'dealt') tip(stamps, COPY.pullBack);
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
      tip(b, label);
      q.append(b);
    }
    headRow.append(q);
  }
  return root;
}
