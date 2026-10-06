// The play loop's engine operations on the synthetic sample (play-loop §2–§9, §14, §0a): preview-mode cover against
// the prospective export, plays that accept only glowing heads, widening that keeps acceptances, the Open pile as a
// set, per-lane weight with the block-header split, and the boss tally keyed to the deck revision.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Case, Disposition } from '../src/deck/types';
import type { Room } from '../src/rooms';
import { caseFor } from '../src/rooms';
import { draftCards } from '../src/deck/templates';
import { deckExportMap, newDeck, presentCards, renderLanes, type DeckState } from '../src/deck/deck';
import { lineWeight } from '../src/deck/file';
import { cover, coverPreview, openCases } from '../src/cover';
import { acceptOnHead, answerBoss, bossCandidates, bossTally, deckRevision, NO_ELIGIBLE_HEAD, openPile, playCard, previewDrop, retarget, tallyCurrent, weightPreview } from '../src/play';
import { sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let room: Room;
let label: (c: Case) => string;
const base = (): DeckState => newDeck(sampleClaudeMd(), sampleAgentsMd());
const stamped = (r: Room, d: Disposition, withheld = false) => (withheld ? r.withheld : r.episodes).map((e) => ({ ...caseFor(e, r), disposition: d }));

beforeAll(async () => {
  const A = await sampleAnalysis();
  room = A.rooms.find((x) => x.family === 'directive' && x.withheld.length > 0)!;
  label = (c) => A.labels.get(c.evidenceRefs[0]!.sessionId)!;
});

describe('preview-mode cover (§14.4, §0a.2)', () => {
  test('a beast drop glows every eligible head; a CLAUDE.md drop never glows a Codex head', () => {
    const heads = stamped(room, 'issue');
    const card = draftCards(room)[0]!;
    const beast = previewDrop(base(), card, heads, 'beast');
    expect(beast.eligible.length).toBe(3);
    expect(beast.finalTargets).toBe('both');
    expect(beast.destinations).toEqual(['claude', 'codex']);
    const claude = previewDrop(base(), card, heads, 'claude');
    expect(claude.heads.filter((h) => h.preview.eligible).map((h) => h.agent)).toEqual(['claude']);
    for (const h of claude.heads.filter((x) => x.agent === 'codex')) expect(h.preview.failing).toEqual({ check: 'targets_agent', tri: 'false' });
    expect(claude.destinations).toEqual(['claude']);
  });

  test('a wrapped head reads "read first": check 1 unknown is never treated as true', () => {
    const heads = stamped(room, 'unreviewed');
    const p = previewDrop(base(), draftCards(room)[0]!, heads, 'beast');
    for (const h of p.heads) expect(h.preview.failing).toEqual({ check: 'confirmed_issue', tri: 'unknown' });
    expect(p.refused).toBe(NO_ELIGIBLE_HEAD);
  });

  test('a draft no head is eligible for is refused on the beast without changing the deck; a book still takes it', () => {
    const heads = stamped(room, 'issue');
    const reread = draftCards(room)[1]!;
    const d = base();
    const refused = playCard(d, reread, heads, 'beast');
    expect(refused.refused).toBe(NO_ELIGIBLE_HEAD);
    expect(refused.deck).toBe(d);
    for (const h of previewDrop(d, reread, heads, 'beast').heads) expect(h.preview.failing!.check).toBe('response_eligible');
    const book = playCard(d, reread, heads, 'claude');
    expect(book.refused).toBeNull();
    expect(book.accepted).toEqual([]);
    expect(presentCards(book.deck).some((c) => c.id === reread.id)).toBe(true);
  });

  test('coverPreview treats checks 2 and 8 as true but a blocked lane still fails check 3', () => {
    const h = stamped(room, 'issue').find((c) => c.agent === 'codex')!;
    const card = draftCards(room)[0]!;
    const blocked = coverPreview(card, h, { claude: new Set([card.id]), codex: new Set() }, 'both');
    expect(blocked.failing).toEqual({ check: 'targets_agent', tri: 'false' });
    const open = coverPreview(card, h, { claude: new Set([card.id]), codex: new Set([card.id]) }, 'both');
    expect(open.eligible).toBe(true);
    // The real cover() still says no: the mapping was never accepted.
    expect(cover(card, h, { claude: new Set([card.id]), codex: new Set([card.id]) }).covers).toBe(false);
  });
});

describe('plays (§2, §3, §14.2–3)', () => {
  test('a beast play accepts only the glowing heads, binds them through the real cover rule, and never touches a stamp', () => {
    const heads = stamped(room, 'issue');
    heads[2] = { ...heads[2]!, disposition: 'unreviewed' };
    const before = heads.map((h) => h.disposition);
    const r = playCard(base(), draftCards(room)[0]!, heads, 'beast');
    expect(r.accepted).toEqual([heads[0]!.id, heads[1]!.id]);
    expect(r.results.map((x) => x.bound)).toEqual([true, true, false]);
    expect(r.results[2]!.result.checks.confirmed_issue).toBe('unknown');
    expect(heads.map((h) => h.disposition)).toEqual(before);
  });

  test('a CLAUDE.md play binds the Claude head only; widening to both keeps it and manufactures nothing; a head drop then accepts a Codex head', () => {
    const heads = stamped(room, 'issue');
    const card = draftCards(room)[0]!;
    const r = playCard(base(), card, heads, 'claude');
    expect(r.card!.targets).toBe('claude');
    expect(r.results.filter((x) => x.bound).map((x) => label(heads.find((h) => h.id === x.caseId)!))).toEqual(['S01']);
    const wide = retarget(r.deck, card.id, 'both');
    expect(wide.refused).toBeNull();
    const ex = deckExportMap(wide.deck, renderLanes(wide.deck));
    const k = presentCards(wide.deck).find((c) => c.id === card.id)!;
    expect(heads.map((h) => cover(k, h, ex).covers)).toEqual([true, false, false]);
    const codexHead = heads.find((h) => h.agent === 'codex')!;
    const acc = acceptOnHead(wide.deck, card.id, codexHead);
    expect(acc.preview!.eligible).toBe(true);
    const k2 = presentCards(acc.deck).find((c) => c.id === card.id)!;
    expect(cover(k2, codexHead, deckExportMap(acc.deck, renderLanes(acc.deck))).covers).toBe(true);
  });

  test('imported prose cannot be re-targeted', () => {
    const d = base();
    const prose = presentCards(d)[0]!;
    expect(retarget(d, prose.id, 'both').refused).toContain('stays in that file');
  });
});

describe('the Open pile is a set (§0a.7)', () => {
  test('confirmed cases without coverage, each once, whatever the input repeats', () => {
    const heads = stamped(room, 'issue');
    const r = playCard(base(), draftCards(room)[0]!, heads, 'claude');
    const open = openPile(r.deck, [...heads, ...heads, { ...heads[0]!, disposition: 'not-a-problem', id: 'set-aside' }]);
    expect(open.map((id) => label(heads.find((h) => h.id === id)!))).toEqual(['S03', 'S06']);
    expect(openPile(r.deck, heads)).toEqual(open);
    const cards = presentCards(r.deck);
    expect(openCases(cards, heads, deckExportMap(r.deck, renderLanes(r.deck)))).toEqual(open);
  });
});

describe('weight preview per lane (§14.10, §0a.9)', () => {
  test('the first managed card splits into line and block header per lane; every part sums to the real delta', () => {
    const card = draftCards(room)[0]!;
    const r = playCard(base(), card, stamped(room, 'issue'), 'beast');
    const w = weightPreview(base(), r.deck);
    expect(w.estimated).toBe(true);
    for (const lane of [w.claude, w.codex]) {
      expect(lane.firstManaged).toBe(true);
      expect(lane.line).toBe(lineWeight(card.text, card.id));
      expect(lane.line + lane.blockHeader + lane.other).toBe(lane.delta);
      expect(lane.after - lane.before).toBe(lane.delta);
    }
    expect([w.claude.before, w.codex.before]).toEqual([104, 33]);
    // A second card in the same file adds its line and no header.
    const second = playCard(r.deck, draftCards(room)[1]!, [], 'claude');
    const w2 = weightPreview(r.deck, second.deck);
    expect(w2.claude.firstManaged).toBe(false);
    expect(w2.claude.blockHeader).toBe(0);
    expect(w2.codex.delta).toBe(0);
  });
});

describe('the boss (§9, §14.8, §0a.11–12)', () => {
  test('S11 and S12 face the final deck; the answer drag binds; the tally prints set-asides and locks to the revision', () => {
    const heads = stamped(room, 'issue');
    const played = playCard(base(), draftCards(room)[0]!, heads, 'beast').deck;
    const withheld = stamped(room, 'issue', true);
    expect(withheld.map(label).sort()).toEqual(['S11', 'S12']);
    const t0 = bossTally(played, withheld, heads);
    expect(t0.later).toEqual({ addressed: 0, confirmed: 2 });
    for (const h of t0.heads) expect(h.candidates.find((c) => c.cardId === draftCards(room)[0]!.id)!.eligible).toBe(true);
    let d = played;
    for (const h of withheld) d = answerBoss(d, draftCards(room)[0]!.id, h).deck;
    const t1 = bossTally(d, withheld, heads);
    expect(t1.later).toEqual({ addressed: 2, confirmed: 2 });
    expect(t1.earlier).toEqual({ addressed: 3, confirmed: 3, open: [] });
    expect(tallyCurrent(t0, d)).toBe(false);
    expect(tallyCurrent(t1, d)).toBe(true);
    expect(t1.revision).toBe(deckRevision(d));
    const aside = bossTally(d, [{ ...withheld[0]!, disposition: 'not-a-problem' }, { ...withheld[1]!, disposition: 'pivot' }], heads);
    expect(aside.setAside).toEqual({ notAProblem: 1, changeOfPlan: 1, unclear: 0 });
    expect(aside.later.confirmed).toBe(0);
  });

  test('a Claude-only deck shows "No eligible card" for the Codex head, with a reason per candidate', () => {
    const heads = stamped(room, 'issue');
    const played = playCard(base(), draftCards(room)[0]!, heads, 'claude').deck;
    const withheld = stamped(room, 'issue', true);
    const t = bossTally(played, withheld, heads);
    const codex = t.heads.find((h) => withheld.find((w) => w.id === h.caseId)!.agent === 'codex')!;
    expect(codex.noEligibleCard).toBe(true);
    expect(codex.candidates.every((c) => c.failing !== null)).toBe(true);
    expect(codex.candidates.find((c) => c.cardId === draftCards(room)[0]!.id)!.failing).toEqual({ check: 'in_export', tri: 'false' });
    expect(answerBoss(played, draftCards(room)[0]!.id, withheld.find((w) => w.agent === 'codex')!).deck).toBe(played);
    expect(bossCandidates(played, withheld.find((w) => w.agent === 'claude')!).some((c) => c.eligible)).toBe(true);
  });

  test('the original files: no accepted mapping means applicability not established, and unjudged suggestions are counted', () => {
    const heads = stamped(room, 'issue');
    const t = bossTally(base(), stamped(room, 'issue', true), heads);
    expect(t.original.established).toBe(false);
    expect(t.original.addressed).toBe(0);
    expect(t.original.unknown).toBe(1);
  });
});
