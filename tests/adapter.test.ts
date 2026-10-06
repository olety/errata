// The play-loop adapter on the synthetic sample: views carry engine numbers, acts are the only transitions, and the
// tutorial route runs from the first room to a verified Apply and Undo through a port over a temporary copy.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDeck } from '../src/deck/deck';
import { nodeRoot } from '../src/apply/node-root';
import type { Root } from '../src/apply/types';
import * as A from '../src/ui/playloop/adapter';
import { TUTORIAL } from '../src/ui/sample';
import { SAMPLE_ROOT, sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let fresh: () => A.PlayState;
let label: (caseId: string) => string;

beforeAll(async () => {
  const an = await sampleAnalysis();
  fresh = () => A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true });
  label = (id) => an.labels.get(an.episodes.find((e) => e.id === id)!.sessionId)!;
});

/** Stamp every head of the current room and deal. */
function judgeAndDeal(s: A.PlayState, stamp: 'issue' | 'pivot' = 'issue'): A.PlayState {
  for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, stamp);
  return A.actDeal(s);
}

describe('room 1 on the sample', () => {
  test('the first screen: three wrapped heads, one receipt at a time, sealed sigils, real weights, the Proposed watermark', () => {
    const v = A.selectRoom(fresh())!;
    expect(v.heads.map((h) => [label(h.caseId), h.state])).toEqual([
      ['S01', 'wrapped'],
      ['S03', 'wrapped'],
      ['S06', 'wrapped'],
    ]);
    expect(v.receipts.current!.caseId).toBe(v.heads[0]!.caseId);
    expect(v.receipts.queue.length).toBe(3);
    expect(v.canDeal).toBe(false);
    expect(v.hand).toEqual([]);
    expect(v.route.sealed).toEqual({ count: 2, sigils: ['claude', 'codex'] });
    expect(v.status.text).toBe('synthetic sample · 12 sessions');
    expect(v.books.map((b) => [b.file, b.weight.now, b.weight.allowance, b.proposed])).toEqual([
      ['CLAUDE.md', 104, 1200, true],
      ['AGENTS.md', 33, 1200, true],
    ]);
    expect(v.beast.pips.text).toBe('No confirmed problems · 3 unreviewed');
    expect(v.beast.skin).toBe('suite-wyrm');
  });

  test('stamping advances the receipt; dealing locks stamps until the hand is pulled back; only eligible drafts are dealt', () => {
    let s = fresh();
    const ids = A.selectRoom(s)!.heads.map((h) => h.caseId);
    s = A.actStamp(s, ids[0]!, 'issue');
    expect(A.selectRoom(s)!.receipts.current!.caseId).toBe(ids[1]);
    s = A.actStamp(A.actStamp(s, ids[1]!, 'issue'), ids[2]!, 'issue');
    s = A.actDeal(s);
    const v = A.selectRoom(s)!;
    expect(v.phase).toBe('dealt');
    expect(v.finalizes).toBe('Playing a card or skipping finalizes your stamps for this room.');
    expect(v.hand.map((c) => c.face.title)).toEqual(['Standing instruction']);
    expect(v.hand[0]!.footer!.text).toBe('3 eligible here · 3 newly addressed');
    expect(v.unavailable.map((c) => [c.face.title, c.inspector.unavailable])).toEqual([
      ['Reread on resuming', ['no context summary or handoff earlier in this session']],
      ['Carry it over', ['no context summary or handoff earlier in this session']],
    ]);
    expect(A.actStamp(s, ids[0]!, 'not-a-problem')).toBe(s);
    const back = A.actPullBack(s);
    expect(A.selectRoom(back)!.phase).toBe('judge');
    expect(A.selectRoom(A.actStamp(back, ids[0]!, 'not-a-problem'))!.heads[0]!.state).toBe('sunk');
  });

  test('the drag preview: every head glows on the beast, Codex heads read "not in AGENTS.md" over CLAUDE.md, the ghost splits per lane', () => {
    const s = judgeAndDeal(fresh());
    const id = A.selectRoom(s)!.hand[0]!.id;
    const beast = A.selectDrag(s, id, { kind: 'beast' });
    expect(beast.verb).toBe('play');
    expect(beast.heads.every((h) => h.glow)).toBe(true);
    expect(beast.ghost.claude.text).toBe('+46 line · +22 block header');
    expect(beast.ghost.codex.text).toBe('+46 line · +23 block header');
    expect([beast.ghost.claude.before, beast.ghost.claude.after, beast.ghost.codex.before, beast.ghost.codex.after]).toEqual([104, 172, 33, 102]);
    expect(beast.line!.files).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(beast.accepts.length).toBe(3);
    const book = A.selectDrag(s, id, { kind: 'book', lane: 'claude' });
    expect(book.heads.map((h) => h.word)).toEqual([null, 'not in AGENTS.md', 'not in AGENTS.md']);
    expect(book.ghost.codex.text).toBe('no change');
    expect(A.selectDrag(s, id, { kind: 'shelf' }).verb).toBe('skip');
  });

  test('a beast play binds exactly the true cover results, finalizes the room and leaves the Open pile empty', () => {
    const s0 = judgeAndDeal(fresh());
    const { state, result } = A.actPlay(s0, A.selectRoom(s0)!.hand[0]!.id, 'beast');
    expect(result.bound.map(label)).toEqual(['S01', 'S03', 'S06']);
    expect(result.standing).toEqual([]);
    expect(result.finalized).toBe(true);
    expect(result.ink.map((x) => x.file)).toEqual(['CLAUDE.md', 'AGENTS.md']);
    const v = A.selectRoom(state)!;
    expect(v.phase).toBe('done');
    expect(v.beast.pips).toMatchObject({ text: '3/3 confirmed addressed', fully: true });
    expect(v.piles.open).toEqual([]);
    expect(v.books.map((b) => b.weight.now)).toEqual([172, 102]);
  });

  test('a CLAUDE.md play leaves the Codex heads standing: two pages on the Open pile, once each', () => {
    const s0 = judgeAndDeal(fresh());
    const { state, result } = A.actPlay(s0, A.selectRoom(s0)!.hand[0]!.id, 'claude');
    expect(result.bound.map(label)).toEqual(['S01']);
    expect(result.standing.map(label)).toEqual(['S03', 'S06']);
    const v = A.selectRoom(state)!;
    expect(v.heads.map((h) => h.state)).toEqual(['bound', 'standing', 'standing']);
    expect(v.piles.open.map((p) => label(p.caseId))).toEqual(['S03', 'S06']);
    expect(v.route.knots[0]!.open).toBe(2);
    expect(v.beast.pips.fully).toBe(false);
  });

  test('a refused beast drop does not spend the pick; skipping shelves the hand and finalizes', () => {
    let s = fresh();
    const ids = A.selectRoom(s)!.heads.map((h) => h.caseId);
    s = A.actDeal(A.actStamp(s, ids[0]!, 'issue'));
    const reread = A.selectRoom(s)!.unavailable[0]!.id;
    expect(A.actPlay(s, reread, 'beast').result.refused).toBe('That card is not in this hand.');
    const sk = A.actSkip(s);
    expect(sk.result.skipped).toBe(true);
    expect(sk.result.standing.map(label)).toEqual(['S01']);
    expect(A.selectPiles(sk.state).shelf.map((c) => c.face.title)).toEqual(['Standing instruction']);
  });

  test('every judged head set aside offers Continue at once', () => {
    let s = fresh();
    for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, 'not-a-problem');
    expect(A.selectRoom(s)!.offer).toBe('continue-all-set-aside');
    expect(A.selectRoom(s)!.beast.pips.text).toBe('No confirmed problems');
    const next = A.actAdvance(s);
    expect(next.node).toBe(1);
  });
});

describe('folder grants (real logs read the files at Apply)', () => {
  test('a grant rebases the deck on the files as read now; taken cards and the boss view keep their cards', async () => {
    let s = judgeAndDeal(fresh());
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    const grown = new TextEncoder().encode(new TextDecoder().decode(sampleClaudeMd()) + '- Keep diffs small.\n');
    const port: A.ApplyPort = { roots: () => null, needs: () => ({ claude: false, codex: false, agents: true }), readSkill: async () => null, ensureWritable: async () => true, grant: async () => ({ claude: grown, codex: sampleAgentsMd(), override: null, loaded: { claude: true, codex: true } }) };
    const g = await A.actGrant(s, port, 'claude');
    const books = A.selectBooks(g);
    expect(books[0]!.weight.now).toBeGreaterThan(A.selectBooks(s)[0]!.weight.now);
    expect(g.deck.cards.map((c) => c.id)).toEqual(s.deck.cards.map((c) => c.id));
    expect(A.selectRoom(g)!.result!.bound.length).toBe(3);
    const cancelled = await A.actGrant(s, { ...port, grant: async () => null }, 'claude');
    expect(cancelled).toBe(s);
  });
});

describe('the tutorial route to Apply and Undo', () => {
  let tmp: string;
  let roots: Root[];
  const port = (): A.ApplyPort => ({ roots: () => roots, needs: () => ({ claude: false, codex: false, agents: false }), readSkill: async (root, rel) => (root === "codex-legacy-skills" ? null : roots.find((r) => r.id === root)!.read(rel)), ensureWritable: async () => true, grant: async () => null });

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'errata-adapter-'));
    await cp(join(SAMPLE_ROOT, 'home'), join(tmp, 'home'), { recursive: true });
    roots = [
      await nodeRoot('claude', join(tmp, 'home/.claude')),
      await nodeRoot('codex', join(tmp, 'home/.codex')),
      await nodeRoot('claude-skills', join(tmp, 'home/.claude/skills')),
      await nodeRoot('codex-skills', join(tmp, 'home/.agents/skills')),
      await nodeRoot('backup', join(tmp, 'home/.claude')),
    ];
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('room → event → campfire (settle with the written exception, fuse uv) → rooms → boss → Apply → Undo', async () => {
    let s = judgeAndDeal(fresh());
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    s = A.actAdvance(s);
    expect(A.selectScreen(s).kind).toBe('event');
    s = A.actStamp(s, A.selectRoom(s)!.heads[0]!.caseId, 'pivot');
    expect(A.selectRoom(s)!.heads[0]!.state).toBe('heron');
    s = A.actAdvance(s);
    const fire = A.selectScreen(s);
    expect(fire.kind).toBe('campfire');
    if (fire.kind !== 'campfire') return;
    const red = fire.view.threads.find((t) => t.color === 'red')!;
    const full = fire.view.lanes.codex.find((c) => c.inspector.exact === TUTORIAL.redLink.onLine)!;
    const preview = A.selectChangePreview(s, { threadId: red.id, resolution: { kind: 'exception', on: full.id, text: TUTORIAL.redLink.text, when: {} } })!;
    expect(preview.lines.find((l) => l.id === full.id)!.text).toBe('Run the full test suite before reporting done, unless the user names a test file.');
    expect(preview.cases.text).toBe('Affected cases: 0 · deck total: 3 → 3');
    s = A.actSettle(s, red.id, { kind: 'exception', on: full.id, text: TUTORIAL.redLink.text, when: {} });
    const uv = A.selectCampfire(s).threads.find((t) => t.color === 'gold' && t.members.length === 3)!;
    const fusePv = A.selectChangePreview(s, { threadId: uv.id })!;
    expect(fusePv.ghost.claude.delta).toBeLessThan(0);
    s = A.actFuse(s, uv.id, uv.autoText!);
    expect(A.selectCampfire(s).threads.some((t) => t.color === 'red')).toBe(false);
    s = A.actAdvance(s);
    // The review node's rooms and the workshop: stamp, deal, play the first dealt card.
    while (A.selectScreen(s).kind === 'room') {
      s = judgeAndDeal(s);
      const v = A.selectRoom(s)!;
      s = v.hand.length ? A.actPlay(s, v.hand[v.kind === 'workshop' ? 2 : 0]!.id, 'beast').state : A.actSkip(s).state;
      s = A.actAdvance(s);
    }
    expect(A.selectScreen(s).kind).toBe('campfire');
    s = A.actAdvance(s);
    const boss = A.selectBoss(s);
    expect(boss.cards.length).toBeGreaterThan(0);
    expect(boss.books.map((b) => b.file)).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(boss.heads.map((h) => [h.source, label(h.caseId)])).toEqual([
      ['sealed', 'S11'],
      ['sealed', 'S12'],
    ]);
    expect(boss.heads[0]!.receipt.quote).not.toBeNull();
    expect(boss.score.lines[0]).toBe('Later cases: none confirmed a problem · 0 set aside (0 not a problem, 0 a change of plan, 0 unclear) · 2 not yet stamped');
    for (let i = 0; i < 2; i++) {
      const cur = A.selectBoss(s).current!;
      s = A.actBossStamp(s, cur, 'issue');
      expect(A.actBossStamp(s, cur, 'not-a-problem')).toBe(s);
      const b = A.selectBoss(s);
      const g = b.candidates.find((c) => c.glow)!;
      expect(A.selectDrag(s, g.cardId, { kind: 'head', caseId: cur }).verb).toBe('answer');
      s = A.actBossNext(A.actBossAnswer(s, g.cardId, cur));
    }
    const locked = A.selectBoss(s).score;
    expect(locked.locked).toBe(true);
    expect(locked.later).toEqual({ addressed: 2, confirmed: 2 });
    expect(locked.lines[0]).toBe('Later cases: 2 of 2 addressed · 0 set aside (0 not a problem, 0 a change of plan, 0 unclear)');
    s = A.actAdvance(s);
    expect(A.selectScreen(s, port()).kind).toBe('apply');
    s = await A.actPrepareApply(s, port());
    const v = A.selectApply(s, port());
    expect(v.blockers).toEqual([]);
    expect(v.canSeal).toBe(true);
    expect(v.stamps).toEqual({ reviewed: 'pending', fits: 'pending', written: 'pending' });
    expect(v.diffs.map((d) => d.kind)).toEqual(['skill', 'global', 'global']);
    s = await A.actSeal(s, port());
    const after = A.selectApply(s, port());
    expect(after.result!.status).toBe('written');
    expect(after.stamps).toEqual({ reviewed: 'inked', fits: 'inked', written: 'inked' });
    expect(A.selectBooks(s).every((b) => !b.proposed)).toBe(true);
    const claude = (await readFile(join(tmp, 'home/.claude/CLAUDE.md'))).toString();
    expect(claude).toContain('run only the test file for the change');
    expect(claude).toContain('## Notes\nMonorepo tooling lives under tools/. Ask before touching CI config.\n');
    s = await A.actUndo(s, port());
    expect(A.selectApply(s, port()).undo!.status).toBe('done');
    expect((await readFile(join(tmp, 'home/.claude/CLAUDE.md'))).equals(Buffer.from(sampleClaudeMd()))).toBe(true);
    expect((await readFile(join(tmp, 'home/.codex/AGENTS.md'))).equals(Buffer.from(sampleAgentsMd()))).toBe(true);
  });

  test('an unsettled red thread blocks the seal and Return to the final campfire selects it; the locked score goes stale on change', () => {
    let s = judgeAndDeal(fresh());
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    while (A.selectScreen(s).kind !== 'apply') {
      const sc = A.selectScreen(s);
      if (sc.kind === 'room' || sc.kind === 'event') s = A.actSkip(judgeAndDeal(s, sc.kind === 'event' ? 'pivot' : 'issue')).state;
      if (sc.kind === 'boss') for (const h of sc.view.heads) s = A.actBossNext(A.actBossStamp(s, h.caseId, 'issue'));
      s = A.actAdvance(s);
    }
    const v = A.selectApply(s);
    const red = v.blockers.find((b) => b.kind === 'conflict')!;
    expect(v.canSeal).toBe(false);
    const back = A.actReturnToCampfire(s, red.select);
    expect(A.selectScreen(back).kind).toBe('campfire');
    expect(A.selectCampfire(back).focusedPair!.threadId).toBe(red.select!.threadId!);
    const lockedBefore = s.boss.locked!;
    const changed = A.actSettle(back, red.select!.threadId!, { kind: 'keep', keep: A.selectCampfire(back).focusedPair!.a });
    expect(changed.boss.locked).toBe(lockedBefore);
    // Back at the boss node the locked score is stale until it is locked again.
    const atBoss = { ...changed, node: changed.route.findIndex((n) => n.kind === 'boss') };
    expect(A.selectBoss(atBoss).score.stale).toBe(true);
    expect(A.selectBoss(A.actLockScore(atBoss)).score.stale).toBe(false);
  });
});
