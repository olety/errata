// Holes Astra found in the P0 contract, each pinned by a test: the Workshop forge, campfire previews for every change,
// pinned-case eligibility, the inspector's data separation, and the copy selectors' honesty.
import { beforeAll, describe, expect, test } from 'bun:test';
import { newDeck } from '../src/deck/deck';
import * as A from '../src/ui/playloop/adapter';
import { bossReason, casesText, clearText, footerText, ghostText, pipsText, provenanceText, sealedText, strapText } from '../src/ui/playloop/contract';
import { sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let fresh: () => A.PlayState;
beforeAll(async () => {
  const an = await sampleAnalysis();
  fresh = () => A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true });
});

function playRoom(s: A.PlayState, stamp: 'issue' | 'pivot' = 'issue'): A.PlayState {
  for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, stamp);
  s = A.actDeal(s);
  const v = A.selectRoom(s)!;
  return v.hand.length ? A.actPlay(s, v.hand[0]!.id, 'beast').state : A.actSkip(s).state;
}

/** Walk to the first node of a kind, playing each room's first card. */
function walkTo(s: A.PlayState, kind: string): A.PlayState {
  for (let i = 0; i < 20 && A.currentNode(s)?.kind !== kind; i++) {
    const sc = A.selectScreen(s);
    if (sc.kind === 'room') s = playRoom(s);
    if (sc.kind === 'event') s = A.actStamp(s, sc.view.heads[0]!.caseId, 'pivot');
    s = A.actAdvance(s);
  }
  return s;
}

describe('the Workshop forge', () => {
  test('lanterns are never stamped or counted; the bench forges a Skill into the proposal with nothing accepted', () => {
    const s0 = walkTo(fresh(), 'workshop');
    const v = A.selectRoom(s0)!;
    expect(v.kind).toBe('workshop');
    expect(v.heads.every((h) => h.state === 'lantern')).toBe(true);
    expect(v.review).toEqual({ remaining: 0, canFinalize: true });
    expect(A.actStamp(s0, v.heads[0]!.caseId, 'issue')).toBe(s0);
    const s1 = A.actDeal(s0);
    const skill = A.selectRoom(s1)!.hand.find((c) => c.type === 'skill')!;
    const pv = A.selectDrag(s1, skill.id, { kind: 'beast' });
    expect(pv.verb).toBe('forge');
    expect(pv.accepts).toEqual([]);
    expect(pv.heads.every((h) => !h.glow)).toBe(true);
    const { state, result } = A.actPlay(s1, skill.id, 'beast');
    expect(result.played).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(A.selectRoom(state)!.deck.some((c) => c.id === skill.id)).toBe(true);
    expect(A.selectPiles(state).openCount).toBe(0);
  });
});

describe('campfire previews for every change', () => {
  test('swap, re-target and sharpen each preview the change they commit, with the result card and its trigger', () => {
    let s = walkTo(fresh(), 'campfire');
    const deckCard = s.deck.cards[0]!;
    const re = A.selectChangePreview(s, { retarget: { cardId: deckCard.id, targets: 'claude' } })!;
    expect(re.resultId).toBe(deckCard.id);
    expect(re.after!.targets).toBe('claude');
    expect(re.after!.trigger).not.toBeNull();
    expect(re.ghost.codex.delta).toBeLessThan(0);
    const sh = A.selectChangePreview(s, { sharpen: { cardId: deckCard.id, text: 'Run only the test file for the change.' } })!;
    expect(sh.after!.text).toBe('Run only the test file for the change.');
    // A new text counts nothing until accepted: its cases are listed for acceptance.
    expect(sh.needsAcceptance.length).toBeGreaterThan(0);
    const sw = A.selectChangePreview(s, { swap: { shelfId: 'nope', deckId: deckCard.id } })!;
    expect(sw.refused).toBe('Swap only with a deck card of the same family.');
    const fuse = A.selectCampfire(s).threads.find((t) => t.color === 'gold' && t.members.length === 3)!;
    const fp = A.selectChangePreview(s, { threadId: fuse.id })!;
    expect(fuse.members).toContain(fp.resultId!);
    const red = A.selectCampfire(s).threads.find((t) => t.color === 'red')!;
    expect(A.selectChangePreview(s, { threadId: red.id, resolution: { kind: 'cancel' } })!.refused).toBe('Cancel leaves the red thread.');
    s = A.actSettle(s, red.id, { kind: 'cancel' });
    expect(s.ops.settle).toBeUndefined();
  });

  test("a pinned Open receipt shows each deck card's eligibility, never coverage", () => {
    let s = fresh();
    for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, 'issue');
    s = A.actDeal(s);
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'claude').state;
    s = walkTo(s, 'campfire');
    const open = A.selectPiles(s).open;
    expect(open.length).toBe(2);
    const pinned = A.selectCampfire(A.actPin(s, open[0]!.caseId));
    expect(pinned.pinned!.caseId).toBe(open[0]!.caseId);
    const standing = pinned.pinnedCandidates.find((c) => s.deck.cards.some((g) => g.id === c.cardId))!;
    expect(standing.glow).toBe(false);
    expect(standing.reason).toBe('Codex · not in AGENTS.md');
    expect(A.selectCampfire(s).pinnedCandidates).toEqual([]);
  });
});

describe('the inspector', () => {
  test('a withheld case stays out of the inspector until the boss reveals it; a receipt opens with its room queue', () => {
    const s = fresh();
    const r = s.rooms.find((x) => x.withheld.length > 0)!;
    expect(A.selectInspector(s, { caseId: r.withheld[0]!.id })).toBeNull();
    const insp = A.selectInspector(s, { caseId: r.anchor.id })!;
    expect(insp.kind).toBe('case');
    if (insp.kind === 'case') expect(insp.queue.length).toBe(r.episodes.length);
    const route = A.selectRoute(s);
    expect(route.knots[0]!.caseIds).toEqual(expect.arrayContaining(r.episodes.map((e) => e.id)));
    expect(route.knots.flatMap((k) => k.caseIds).some((id) => r.withheld.some((w) => w.id === id))).toBe(false);
  });
});

describe('copy selectors', () => {
  test('the unreviewed count always prints; offsetting ghost parts are not "no change"; an unknown scope is not a mismatch', () => {
    expect(pipsText(3, 3, 0)).toBe('3 of 3 cases answered by a proposed line · 0 unreviewed');
    expect(pipsText(0, 1, 0)).toBe('0 of 1 case answered by a proposed line · 0 unreviewed');
    expect(pipsText(0, 0, 2)).toBe('No cases confirmed as a problem · 2 unreviewed');
    expect(ghostText({ delta: 0, line: 0, blockHeader: 22, other: -22 })).toBe('+22 block header (the one-time marker lines) · −22 other text');
    expect(ghostText({ delta: 59, line: 60, blockHeader: 0, other: -1 })).toBe('+60 line · −1 rounding');
    expect(footerText(3, 3)).toBe('answers 3 cases here');
    expect(footerText(1, 0)).toBe('answers 1 case here');
    expect(casesText(0, 3, 3)).toBe('cases answered by the whole deck: 3 → 3 (this change affects 0)');
    expect(strapText(104, 1200)).toEqual({ weight: 'file weight 104 of 1,200 tok', left: 'room left 1,096' });
    expect(strapText(1230, 1200)).toEqual({ weight: 'file weight 1,230 of 1,200 tok', left: 'over the allowance by 30' });
    expect(provenanceText('other', 3)).toBe('seen in 3 sessions');
    expect(provenanceText('other', 1)).toBe('seen once');
    expect(provenanceText('workflow', 2)).toBe('seen passing in 2 sessions');
    expect(sealedText(2)).toBe('2 later cases held for the boss');
    expect(clearText(3, 0)).toBe('3 cases now have a proposed line. Nothing is prevented; lines land only when you Apply.');
    expect(ghostText({ delta: 0, line: 0, blockHeader: 0, other: 0 })).toBe('no change');
    expect(ghostText({ delta: 68, line: 46, blockHeader: 22, other: 0 })).toBe('+46 line · +22 block header (the one-time marker lines)');
    expect(bossReason('scope_matches', 'unknown', { agent: 'codex', project: null })).toBe('project unknown · applicability not established');
    expect(bossReason('scope_matches', 'false', { agent: 'codex', project: 'datalad' })).toBe('datalad · scoped elsewhere');
  });
});
