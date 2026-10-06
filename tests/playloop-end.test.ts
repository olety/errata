// The boss/apply presentation helpers (src/ui/playloop/end/model.ts) on the synthetic sample: what the boss and Apply
// screens show at each turn, read from real adapter views. The helpers never compute a game number; these tests check
// that every printed line is the view's own, that the blind stamp shows no hint, and that each ink and fold is honest.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDeck } from '../src/deck/deck';
import { nodeRoot } from '../src/apply/node-root';
import type { Root } from '../src/apply/types';
import * as A from '../src/ui/playloop/adapter';
import type { ApplyView, BossView } from '../src/ui/playloop/contract';
import { COPY, STAMPS } from '../src/ui/playloop/contract';
import { applyPlan, blockerActions, bookRows, bossPlan, busyText, diffRows, headLook, inkFresh, plateBox, PLATE, scoreNote, splitTicks, stampLabel, summaryPlan, tagText } from '../src/ui/playloop/end/model';
import { SAMPLE_ROOT, sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let fresh: () => A.PlayState;

beforeAll(async () => {
  const an = await sampleAnalysis();
  fresh = () => A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true });
});

/**
 * The route to the boss as a player might walk it: the first room's standing instruction goes into CLAUDE.md only (so
 * no red thread opens and the Codex sealed head finds no eligible card), the event is a change of plan, every other
 * room plays its first dealt card on the beast, and both campfires are left at once.
 */
function toBoss(): A.PlayState {
  let s = fresh();
  for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, 'issue');
  s = A.actDeal(s);
  s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'claude').state;
  s = A.actAdvance(s);
  for (let i = 0; i < 20 && A.selectScreen(s).kind !== 'boss'; i++) {
    const sc = A.selectScreen(s);
    if (sc.kind === 'room' || sc.kind === 'event') {
      for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, sc.kind === 'event' ? 'pivot' : 'issue');
      if (sc.kind === 'room') {
        s = A.actDeal(s);
        const v = A.selectRoom(s)!;
        s = v.hand.length ? A.actPlay(s, v.hand[0]!.id, 'beast').state : A.actSkip(s).state;
      }
    }
    s = A.actAdvance(s);
  }
  expect(A.selectScreen(s).kind).toBe('boss');
  return s;
}

// ------------------------------------------------------------------ text helpers

describe('text', () => {
  test('backtick spans split into code segments; an unmatched backtick stays literal', () => {
    expect(splitTicks('When testing with `pytest`, run one file.')).toEqual([
      { code: false, text: 'When testing with ' },
      { code: true, text: 'pytest' },
      { code: false, text: ', run one file.' },
    ]);
    expect(splitTicks('a `b` c `d')).toEqual([
      { code: false, text: 'a ' },
      { code: true, text: 'b' },
      { code: false, text: ' c ' },
      { code: false, text: '`d' },
    ]);
    expect(splitTicks('plain')).toEqual([{ code: false, text: 'plain' }]);
  });

  test('the head tag and the stamp labels come from the receipt and STAMPS', () => {
    expect(tagText({ agent: 'codex', project: 'pyramid', date: '2026-10-05' })).toBe('Codex · pyramid · 2026-10-05');
    expect(tagText({ agent: 'claude', project: null, date: null })).toBe('Claude');
    expect(STAMPS.map((s) => stampLabel(s.stamp))).toEqual(STAMPS.map((s) => s.label));
    expect(stampLabel('unreviewed')).toBeNull();
  });

  test('head looks follow the disposition and addressed only', () => {
    expect(headLook({ disposition: 'unreviewed', addressed: false }, true)).toBe('rising');
    expect(headLook({ disposition: 'unreviewed', addressed: false }, false)).toBe('wrapped');
    expect(headLook({ disposition: 'issue', addressed: false }, true)).toBe('bared');
    expect(headLook({ disposition: 'issue', addressed: false }, false)).toBe('standing');
    expect(headLook({ disposition: 'issue', addressed: true }, false)).toBe('bound');
    expect(headLook({ disposition: 'pivot', addressed: false }, false)).toBe('heron');
    expect(headLook({ disposition: 'not-a-problem', addressed: false }, false)).toBe('sunk');
    expect(headLook({ disposition: 'unclear', addressed: false }, false)).toBe('wrapped');
  });
});

// ------------------------------------------------------------------ the boss

describe('the boss on the sample', () => {
  test('stamp turn: the receipt is readable, the four stamps show, and nothing hints at the answer', () => {
    const v = A.selectBoss(toBoss());
    const plan = bossPlan(v);
    expect(plan.turn).toBe('stamp');
    expect(plan.current!.source).toBe('sealed');
    expect(plan.current!.receipt.quote).toBe('whole suite again?? one file.');
    expect(plan.stamps).toBe(STAMPS);
    expect(plan.chosen).toBeNull();
    // Blind: no glow, no reasons, no target, no draggable cards, and the hidden head stays a count.
    expect(plan.glow.size).toBe(0);
    expect(plan.reasons).toEqual([]);
    expect(plan.headTarget).toBe(false);
    expect(plan.dragCards).toBe(false);
    expect(plan.faced).toEqual([]);
    expect(plan.below).toBe(v.remaining);
    expect(plan.below).toBe(1);
    expect(plan.controls.map((c) => c.act)).toEqual(['next']);
    expect(plan.score.lines).toBe(v.score.lines);
    expect(plan.score.final).toBe(false);
  });

  test('answer turn: only glowing candidates glow, and the head becomes the drop target; answering folds it', () => {
    let s = toBoss();
    const cur = A.selectBoss(s).current!;
    s = A.actBossStamp(s, cur, 'issue');
    const v = A.selectBoss(s);
    const plan = bossPlan(v);
    expect(plan.turn).toBe('answer');
    expect(plan.chosen).toBe('A problem');
    expect([...plan.glow]).toEqual(v.candidates.filter((c) => c.glow).map((c) => c.cardId));
    expect(plan.glow.size).toBeGreaterThan(0);
    expect(plan.headTarget).toBe(true);
    expect(plan.dragCards).toBe(true);
    expect(plan.reasons).toEqual([]);
    expect(plan.controls).toEqual([{ act: 'next', label: 'Continue · leave it open', primary: false }]);
    // In each book, glowing cards come first, so the answer shows without scrolling.
    for (const row of bookRows(v.books, v.cards, plan.glow)) {
      const firstDim = row.cards.findIndex((c) => !plan.glow.has(c.id));
      expect(row.cards.slice(firstDim < 0 ? row.cards.length : firstDim).some((c) => plan.glow.has(c.id))).toBe(false);
    }
    const answered = bossPlan(A.selectBoss(A.actBossAnswer(s, [...plan.glow][0]!, cur)));
    expect(answered.look).toBe('bound');
    expect(answered.headTarget).toBe(false);
    expect(answered.glow.size).toBe(0);
    expect(answered.controls).toEqual([{ act: 'next', label: 'Continue', primary: true }]);
  });

  test('"No eligible card" prints every candidate with its own reason; the Codex head stays open', () => {
    let s = toBoss();
    const first = A.selectBoss(s).current!;
    s = A.actBossStamp(s, first, 'issue');
    const g = A.selectBoss(s).candidates.find((c) => c.glow)!;
    s = A.actBossNext(A.actBossAnswer(s, g.cardId, first));
    const second = A.selectBoss(s);
    expect(second.heads.map((h) => h.receipt.agent)).toEqual(['claude', 'codex']);
    expect(second.remaining).toBe(0);
    s = A.actBossStamp(s, second.current!, 'issue');
    const v = A.selectBoss(s);
    const plan = bossPlan(v);
    expect(v.noEligibleCard).toBe(true);
    expect(plan.coach!.startsWith(COPY.noEligibleCard)).toBe(true);
    expect(plan.reasons.map((r) => [r.cardId, r.reason])).toEqual(v.candidates.map((c) => [c.cardId, c.reason ?? '']));
    expect(plan.reasons.every((r) => r.reason.length > 0)).toBe(true);
    expect(plan.reasons.some((r) => r.reason === 'Codex · not in AGENTS.md')).toBe(true);
    expect(plan.glow.size).toBe(0);
    expect(plan.faced.map((f) => f.look)).toEqual(['bound']);
    expect(plan.controls).toEqual([{ act: 'next', label: 'Continue', primary: true }]);
  });

  test('after the sealed heads the earlier Open pages rise, with no blind stamp; then the score locks', () => {
    let s = toBoss();
    for (let i = 0; i < 2; i++) {
      const cur = A.selectBoss(s).current!;
      s = A.actBossStamp(s, cur, i === 0 ? 'issue' : 'not-a-problem');
      const g = A.selectBoss(s).candidates.find((c) => c.glow);
      s = A.actBossNext(g ? A.actBossAnswer(s, g.cardId, cur) : s);
    }
    let v = A.selectBoss(s);
    let opened = 0;
    while (v.current) {
      const plan = bossPlan(v);
      expect(plan.current!.source).toBe('open');
      expect(plan.stamps).toBeNull();
      expect(plan.turn).toBe('answer');
      opened++;
      s = A.actBossNext(s);
      v = A.selectBoss(s);
    }
    expect(opened).toBeGreaterThan(0);
    const plan = bossPlan(v);
    expect(plan.turn).toBe('summary');
    expect(plan.current).toBeNull();
    expect(plan.score.lines).toEqual(v.score.lines);
    expect(plan.score.validity).toBe('locked');
    expect(plan.score.final).toBe(true);
    expect(plan.controls).toEqual([{ act: 'advance', label: 'Go to Apply', primary: true }]);
    expect(plan.setAside.map((x) => [x.head.receipt.agent, x.label])).toEqual([['codex', 'Not a problem']]);
    expect(plan.faced.length).toBe(v.heads.length);
    // The set-aside count prints beside the score in the view's own line.
    expect(plan.score.lines[0]).toContain('1 set aside (1 not a problem');
  });

  test('a stale score is never final and offers to lock again before Apply', () => {
    let s = toBoss();
    while (A.selectBoss(s).current) {
      const cur = A.selectBoss(s).current!;
      if (A.selectBoss(s).turn === 'stamp') s = A.actBossStamp(s, cur, 'issue');
      s = A.actBossNext(s);
    }
    const v = A.selectBoss(s);
    const stale: BossView = { ...v, score: { ...v.score, validity: 'stale' } };
    const plan = bossPlan(stale);
    expect(plan.score.final).toBe(false);
    expect(plan.controls.map((c) => [c.act, c.primary])).toEqual([
      ['relock', true],
      ['advance', false],
    ]);
    expect(scoreNote('live').final).toBe(false);
    expect(scoreNote('stale').final).toBe(false);
    expect(scoreNote('locked').final).toBe(true);
  });

  test('a Final Audit is named as such', () => {
    const v = A.selectBoss(toBoss());
    expect(bossPlan({ ...v, kind: 'audit' }).title).toBe('Final Audit');
    expect(bossPlan(v).title).toBe('The sealed heads');
  });
});

// ------------------------------------------------------------------ Apply

describe('Apply', () => {
  let tmp: string;
  let roots: Root[];
  const port = (): A.ApplyPort => ({
    roots: () => roots,
    needs: () => ({ claude: false, codex: false, agents: false }),
    readSkill: async (root, rel) => (root === 'codex-legacy-skills' ? null : roots.find((r) => r.id === root)!.read(rel)),
    ensureWritable: async () => true,
    grant: async () => null,
  });

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'errata-end-'));
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

  test('the seal, the three stamps, the result files, Undo and the pane follow the view only', async () => {
    let s = toBoss();
    while (A.selectBoss(s).current) {
      const cur = A.selectBoss(s).current!;
      if (A.selectBoss(s).turn === 'stamp') s = A.actBossStamp(s, cur, 'issue');
      const g = A.selectBoss(s).candidates.find((c) => c.glow);
      s = A.actBossNext(g ? A.actBossAnswer(s, g.cardId, cur) : s);
    }
    s = await A.actPrepareApply(A.actAdvance(s), port());
    const before = A.selectApply(s, port());
    const p0 = applyPlan(before);
    expect(p0.seal).toBe(before.canSeal);
    expect(p0.seal).toBe(true);
    expect(p0.blockers).toEqual([]);
    expect(p0.stamps.map((x) => [x.label, x.state])).toEqual([
      ['Reviewed', 'pending'],
      ['Fits', 'pending'],
      ['Written', 'pending'],
    ]);
    expect(p0.pane).toBe('diffs');
    expect(p0.files).toEqual([]);
    // While busy, nothing is live.
    const busy = applyPlan({ ...before, busy: 'sealing' });
    expect(busy.locked).toBe(true);
    expect(busy.seal).toBe(false);
    expect(busy.busyText).toBe(busyText('sealing'));
    // Skill bodies come before the global files in the view's own order.
    expect(before.diffs.map((d) => d.kind)).toEqual([...before.diffs.filter((d) => d.kind === 'skill'), ...before.diffs.filter((d) => d.kind !== 'skill')].map((d) => d.kind));

    s = await A.actSeal(s, port());
    const after = A.selectApply(s, port());
    const p1 = applyPlan(after);
    expect(p1.stamps.every((x) => x.state === 'inked')).toBe(true);
    expect(inkFresh(before.stamps, after.stamps)).toEqual(['reviewed', 'fits', 'written']);
    expect(inkFresh(after.stamps, after.stamps)).toEqual([]);
    expect(p1.files.map((f) => f.text)).toEqual(after.result!.files.map(() => 'written · read back'));
    expect(p1.pane).toBe('run');
    expect(p1.undo).toBe(true);
    expect(after.footer).toBe(COPY.footer);

    s = await A.actUndo(s, port());
    const undone = A.selectApply(s, port());
    expect(applyPlan(undone).undo).toBe(false);
    expect(undone.footer).toBeNull();
    expect(applyPlan(undone).pane).toBe('diffs');
  });

  test('blockers offer the final campfire, a re-read for a stale diff, and grants for missing folders', () => {
    expect(blockerActions({ kind: 'clasp' })).toEqual(['return']);
    expect(blockerActions({ kind: 'conflict' })).toEqual(['return']);
    expect(blockerActions({ kind: 'lane' })).toEqual(['return']);
    expect(blockerActions({ kind: 'stale' })).toEqual(['reread', 'return']);
    expect(blockerActions({ kind: 'grant' })).toEqual(['grant']);
    const v = A.selectApply(toBoss());
    const needs: ApplyView = { ...v, needs: { claude: true, codex: false, agents: true } };
    expect(applyPlan(needs).grants.map((g) => [g.which, g.optional])).toEqual([
      ['claude', false],
      ['agents', true],
    ]);
  });

  test('ink order: each stamp inks once, only when its own state turns inked', () => {
    expect(inkFresh(null, { reviewed: 'inked', fits: 'pending', written: 'pending' })).toEqual(['reviewed']);
    expect(inkFresh({ reviewed: 'inked', fits: 'pending', written: 'pending' }, { reviewed: 'inked', fits: 'inked', written: 'failed' })).toEqual(['fits']);
    expect(inkFresh({ reviewed: 'pending', fits: 'pending', written: 'pending' }, { reviewed: 'failed', fits: 'failed', written: 'failed' })).toEqual([]);
  });

  test('the end summary prints the view: score lines, weights with estimated, raises by you, committed operations', () => {
    const v = A.selectApply(toBoss());
    const plan = summaryPlan({
      ...v.summary,
      operations: [
        { kind: 'add', count: 4 },
        { kind: 'fuse', count: 1 },
        { kind: 'cut', count: 0 },
      ],
      files: [
        { lane: 'claude', file: 'CLAUDE.md', before: 104, after: 1350, allowance: 1500, raisedBy: 1500 },
        { lane: 'codex', file: 'AGENTS.md', before: 33, after: 96, allowance: 1200, raisedBy: null },
      ],
    });
    expect(plan.lines).toBe(v.summary.lines);
    expect(plan.operations).toEqual(['4 added', '1 fused']);
    expect(plan.files).toEqual([
      { file: 'CLAUDE.md', text: '104 → 1,350 of 1,500 · estimated', raised: 'allowance raised to 1,500 by you' },
      { file: 'AGENTS.md', text: '33 → 96 of 1,200 · estimated', raised: null },
    ]);
    expect(plan.openCount).toBe(v.summary.openCount);
  });
});

// ------------------------------------------------------------------ diffs and geometry

describe('diff rows', () => {
  const same = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ op: 'same' as const, line: `s${from + i}` }));

  test('long unchanged runs fold, keeping three lines of context around every change', () => {
    const ops = [...same(10), { op: 'del' as const, line: 'old' }, { op: 'add' as const, line: 'new' }, ...same(10, 10)];
    const rows = diffRows(ops);
    expect(rows[0]).toEqual({ kind: 'fold', from: 0, to: 7 });
    expect(rows.filter((r) => r.kind === 'line').map((r) => (r.kind === 'line' ? r.line : ''))).toEqual(['s7', 's8', 's9', 'old', 'new', 's10', 's11', 's12']);
    expect(rows.at(-1)).toEqual({ kind: 'fold', from: 15, to: 22 });
  });

  test('unfolding every fold gives back the ops exactly; a one-line fold is shown instead', () => {
    const ops = [...same(4), { op: 'add' as const, line: 'x' }, ...same(7, 4), { op: 'del' as const, line: 'y' }, ...same(2, 11)];
    const rows = diffRows(ops);
    const back = rows.flatMap((r) => (r.kind === 'line' ? [{ op: r.op, line: r.line }] : ops.slice(r.from, r.to)));
    expect(back).toEqual(ops);
    expect(rows.some((r) => r.kind === 'fold' && r.to - r.from === 1)).toBe(false);
    // A new file (a Skill body) is all additions: nothing folds.
    const skill = [{ op: 'add' as const, line: '# skill' }, { op: 'add' as const, line: 'body' }];
    expect(diffRows(skill)).toEqual(skill.map((o) => ({ kind: 'line', ...o })));
    expect(diffRows([])).toEqual([]);
  });

  test('the world plate covers the viewport with its shore on shoreY at all three sizes', async () => {
    const { layout } = await import('../src/ui/playloop/geometry');
    for (const vp of [
      { w: 1440, h: 900 },
      { w: 1024, h: 768 },
      { w: 390, h: 844 },
    ]) {
      const b = layout(vp);
      const p = plateBox(vp, b.shoreY);
      expect(Math.abs(p.y + PLATE.shore * p.h - b.shoreY)).toBeLessThanOrEqual(1);
      expect(p.x).toBeLessThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(0);
      expect(p.x + p.w).toBeGreaterThanOrEqual(vp.w - 1);
      expect(p.y + p.h).toBeGreaterThanOrEqual(vp.h - 1);
      expect(Math.abs(p.w / p.h - PLATE.ratio)).toBeLessThan(0.01);
    }
  });
});

// ------------------------------------------------------------------ copy

describe('copy', () => {
  test('no banned word appears anywhere in the end folder', async () => {
    const dir = join(import.meta.dir, '..', 'src/ui/playloop/end');
    const banned = /\b(prevented|killed|defeated|damage|saved time|worked|fired)\b/i;
    for (const f of await readdir(dir)) {
      const text = (await readFile(join(dir, f))).toString();
      expect(`${f}: ${text.match(banned)?.[0] ?? ''}`).toBe(`${f}: `);
    }
  });
});
