// The tutorial's coach lines on the synthetic sample (play-loop §11 as amended by §0a.16): one line per gesture,
// written on the wood, gone when the gesture is done, never a modal and never a forced wait. The uv pair is the
// spotlit first merge; the exception merge (the force-push pair) comes after it, then the red pair. Every line reads
// the views only; nothing here changes the game. Real logs get no coach.

import * as A from './adapter';
import type * as C from './contract';
import { COPY } from './contract';

type Tutorial = NonNullable<C.UiView['tutorial']>;

/** The sample's lines the tutorial points at, by their exact text in the shipped files. */
export const SAMPLE_LINES = {
  uv: 'Use uv, not pip, for installs.',
  forcePush: 'Never force-push, except to your own feature branch right after a rebase.',
} as const;

const line = (text: string, focus: Tutorial['focus'] = null): Tutorial => ({ text, focus });

function roomLine(v: C.RoomView, first: boolean): Tutorial | null {
  if (v.kind === 'event') return line('A change of plan flies off and counts nowhere. A problem turns the heron into a room with one head.');
  if (!first) return null;
  const stamped = v.heads.length - v.review.remaining;
  if (v.phase === 'judge') {
    if (stamped === 0) return line(`Your agents read the two books below. ${COPY.tutorialFiles} You stopped the agent here: read the slip. A problem?`);
    if (v.review.remaining > 0) return line(`Stamp each head from its own words: ${v.review.remaining} still to stamp.`);
    if (v.canDeal) return line('Every head is stamped. Deal the hand.');
    return null;
  }
  if (v.phase === 'dealt') {
    const card = v.hand[0];
    if (!card) return null;
    // The sample's first room deals one card: say why there is only one (§0a.4), honestly.
    const why = v.hand.length === 1 ? 'One response fits what the logs show. ' : '';
    return line(`${why}Drag the card onto the beast: it ${COPY.addsTo} for every agent whose head glows.`, { kind: 'card', cardId: card.id });
  }
  return null;
}

function campfireLine(v: C.CampfireView, pending: C.UiView['pending']): Tutorial | null {
  const text = (id: string) => [...v.lanes.claude, ...v.lanes.both, ...v.lanes.codex].find((c) => c.id === id)?.inspector.exact ?? '';
  const gold = (needle: string) => v.threads.find((t) => t.color === 'gold' && t.members.some((m) => text(m) === needle));
  const red = v.threads.find((t) => t.color === 'red');
  if (pending?.kind === 'stack') {
    const t = v.threads.find((x) => x.id === pending.threadId);
    if (t?.color === 'red') return line('Pick how to settle them. The exported lines show before you seal; Cancel leaves the thread.', { kind: 'thread', threadId: t.id });
    return line('Read the preview, then hold the seal or press Enter. Escape pulls the cards apart.', t ? { kind: 'thread', threadId: t.id } : null);
  }
  if (pending) return null;
  const uv = gold(SAMPLE_LINES.uv);
  if (uv) return line(`A gold thread: ${uv.reason}. Stack the uv cards to merge them.`, { kind: 'thread', threadId: uv.id });
  const fp = gold(SAMPLE_LINES.forcePush);
  if (fp) return line('Exceptions survive a merge: stack the force-push pair and the longer line keeps its exception.', { kind: 'thread', threadId: fp.id });
  if (red) return line('A red thread: two lines disagree, and Apply waits until they are settled. Stack the two red cards.', { kind: 'thread', threadId: red.id });
  return line('The fire is quiet. Leaving is free.');
}

function bossLine(v: C.BossView): Tutorial | null {
  switch (v.turn) {
    case 'stamp':
      return line('A later case rises: the game held it back from the start. Read it, then stamp it blind.');
    case 'answer':
      return v.noEligibleCard ? line(`${COPY.noEligibleCard}: the reasons are on the cards. Continue; this case stays open.`) : line('Drag a glowing card from your deck onto the head.');
    case 'set-aside':
      return line('Set aside. Continue to the next head.');
    case 'summary':
      return line('The score is locked to your final deck. Continue to Apply.');
  }
}

function applyLine(v: C.ApplyView): Tutorial | null {
  if (v.undo?.status === 'done') return null;
  if (v.result?.status === 'written') return line('Written and read back. Undo restores the original bytes.');
  if (v.canSeal) return line('Read both diffs, then press the seal: backups first, and every write is read back.');
  return null;
}

/** The coach line for the current screen, or null. The sample only; every line names one gesture. */
export function tutorialFor(s: A.PlayState, screen: C.Screen, pending: C.UiView['pending']): Tutorial | null {
  if (!s.sample) return null;
  const firstRoom = s.route.findIndex((n) => n.kind === 'encounter' || n.kind === 'elite');
  const firstFire = s.route.findIndex((n) => n.kind === 'campfire');
  switch (screen.kind) {
    case 'room':
    case 'event':
      return roomLine(screen.view, s.node === firstRoom && s.sub === 0);
    case 'campfire':
      return s.node === firstFire ? campfireLine(screen.view, pending) : null;
    case 'boss':
      return bossLine(screen.view);
    case 'apply':
      return applyLine(screen.view);
    default:
      return null;
  }
}
