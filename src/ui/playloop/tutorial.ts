// The tutorial's coach lines on the synthetic sample (play-loop §11 as amended by §0a.16): one line per gesture,
// written on the wood, gone when the gesture is done, never a modal and never a forced wait. At the first fire the red
// pair the player was warned about comes first (P3), then the uv merge, then the exception merge (the force-push pair).
// Every line reads the views only; nothing here changes the game. Real logs get no coach.

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

/** "two" for 2: the route distance to the next campfire in words. */
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

/** Where the next campfire is from here, in words: "The campfire, two rooms on," (P3 gate fix D). */
function fireAhead(s: A.PlayState): string {
  const at = s.route.findIndex((n, i) => i > s.node && n.kind === 'campfire');
  const d = at < 0 ? 0 : at - s.node;
  return d <= 1 ? 'The campfire, next on the route,' : `The campfire, ${WORDS[d] ?? String(d)} rooms on,`;
}

function firstRoomLine(s: A.PlayState, v: C.RoomView, redThread: boolean): Tutorial | null {
  if (v.phase === 'judge') {
    // The coach names the first action (P3 gate fix E); the books and Deal stay dim until the stamps are done.
    if (v.review.remaining === v.heads.length) return line(`Read the slip. Stamp it. You stopped the agent here, and your agents read the two books below: ${COPY.tutorialFiles}`);
    if (v.review.remaining > 0) return line(`Stamp each head from its own words: ${v.review.remaining} still to stamp. The control under the stamps can stamp the rest like the last one.`);
    if (v.canDeal) return line('Every head is stamped. Deal the hand.');
    return null;
  }
  if (v.phase === 'dealt') {
    const card = v.hand[0];
    if (!card) return null;
    // The sample's first room deals one card: say why there is only one (§0a.4), honestly; then the unit (gate fix 1).
    const why = v.hand.length === 1 ? 'One response fits what the logs show. ' : `${v.handDiffers ?? ''} `;
    return line(`${why}Drag the card onto the beast, or click it and then the beast: it ${COPY.addsTo} for every agent whose head glows. +${card.weight} tok is what the line adds to your file.`, { kind: 'card', cardId: card.id });
  }
  // After the play: the new line disagrees with one already in a file (the red thread). Continue leads to the fire.
  if (v.phase === 'done' && v.result?.played && redThread) return line(`A red thread: two lines in your files now disagree. ${fireAhead(s)} settles it. Continue when you are ready.`);
  return null;
}

/** One honest line for each of the sample's later rooms (the event, the middle rooms and the workshop). */
function laterRoomLine(v: C.RoomView): Tutorial | null {
  if (v.kind === 'event') return line('A change of plan flies off and counts nowhere. A problem turns the heron into a room with one head.');
  if (v.phase === 'dealt' && v.handDiffers) return line(v.handDiffers, v.hand[0] ? { kind: 'card', cardId: v.hand[0].id } : null);
  if (v.phase === 'dealt' && v.hand.length === 1) return line('One response fits what the logs show. Play it, or drop it on the shelf to skip for free.', { kind: 'card', cardId: v.hand[0]!.id });
  if (v.phase !== 'judge') return null;
  switch (v.beast.skin) {
    case 'retry-hydra':
      return line('The same command failed again unchanged. The neck rings count the failed runs in this one session. Read the slip, stamp it, then deal.');
    case 'boundary-stag':
      return line('One stop, one head. Read the slip and stamp it; before you deal, you can change the line in your own words.');
    case 'owl':
      return line('A verified workflow: nothing to stamp. Deal, then drop the card on the owl\'s bench to write it as a Skill, or skip it.');
    case 'patch-moth':
      return line('The same file was edited again and again. Read the slip and stamp it, then deal.');
    default:
      return line('Read each slip and stamp it, then deal.');
  }
}

function roomLine(s: A.PlayState, v: C.RoomView, first: boolean, redThread: boolean): Tutorial | null {
  return first ? firstRoomLine(s, v, redThread) : laterRoomLine(v);
}

function campfireLine(v: C.CampfireView, pending: C.UiView['pending']): Tutorial | null {
  const text = (id: string) => [...v.lanes.claude, ...v.lanes.both, ...v.lanes.codex].find((c) => c.id === id)?.inspector.exact ?? '';
  const gold = (needle: string) => v.threads.find((t) => t.color === 'gold' && t.members.some((m) => text(m) === needle));
  const red = v.threads.find((t) => t.color === 'red');
  if (pending?.kind === 'stack') {
    const t = v.threads.find((x) => x.id === pending.threadId);
    if (t?.color === 'red') return line('Pick how to settle them. Keep one starts on your new line; the exported lines show before you seal. Cancel leaves the thread.', { kind: 'thread', threadId: t.id });
    return line('Read the preview, then click the seal or press Enter. Escape pulls the cards apart.', t ? { kind: 'thread', threadId: t.id } : null);
  }
  if (pending) return null;
  // The red thread the player was warned about comes first and is pre-selected (P3 gate fix D).
  if (red) return line('The red thread from your first room: two lines disagree, and Apply waits until they are settled. Stack the two red cards: drag one onto the other, or click one and then the other.', { kind: 'thread', threadId: red.id });
  const uv = gold(SAMPLE_LINES.uv);
  if (uv) return line(`A gold thread: ${uv.reason}. Stack the uv cards to merge them.`, { kind: 'thread', threadId: uv.id });
  const fp = gold(SAMPLE_LINES.forcePush);
  if (fp) return line('Exceptions survive a merge: stack the force-push pair and the longer line keeps its exception.', { kind: 'thread', threadId: fp.id });
  return line('The fire is quiet. Leaving is free.');
}

function bossLine(v: C.BossView): Tutorial | null {
  switch (v.turn) {
    case 'stamp':
      return line('A later case rises: the game held it back from the start. Read it, then stamp it blind.');
    case 'answer':
      return v.noEligibleCard ? line(`${COPY.noEligibleCard}: the reasons are on the cards. Continue; this case stays open.`) : line('Drag a glowing card from your deck onto the head, or click the card and then the head.');
    case 'set-aside':
      return line('Set aside. Continue to the next head.');
    case 'summary':
      return line('The tally is fixed to your final deck: how many later cases its lines answer. Continue to Apply.');
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
      return roomLine(s, screen.view, s.node === firstRoom && s.sub === 0, A.selectCampfire(s).threads.some((t) => t.color === 'red'));
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
