// P3, the polish from the cold-player gate: the mirror's numbers trace, a click does what a drag does, the safe
// defaults at the fire, the honest lines a room prints, the second visit (a kept receipt with stable line ids), and the
// export for browsers without folder access. Engine and adapter level; the rendered checks live in e2e.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDeck } from '../src/deck/deck';
import { BEGIN, END, parseGlobal } from '../src/deck/file';
import { nodeRoot } from '../src/apply/node-root';
import type { Root } from '../src/apply/types';
import * as A from '../src/ui/playloop/adapter';
import { Controller } from '../src/ui/playloop/controller';
import { actLine, mirrorRows } from '../src/ui/mirror-view';
import { forgetApply, linesFromLastApply, loadApply, recordOf, REMEMBER_KEY, saveApply, type Store } from '../src/ui/persist';
import { TUTORIAL } from '../src/ui/sample';
import { SAMPLE_ROOT, sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let an: Awaited<ReturnType<typeof sampleAnalysis>>;
let fresh: () => A.PlayState;

beforeAll(async () => {
  an = await sampleAnalysis();
  fresh = () => A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true });
});

function judgeAndDeal(s: A.PlayState, stamp: 'issue' | 'pivot' = 'issue'): A.PlayState {
  for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, stamp);
  return A.actDeal(s);
}

function toFirstFire(): A.PlayState {
  let s = judgeAndDeal(fresh());
  s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
  s = A.actAdvance(s);
  s = A.actStamp(s, A.selectRoom(s)!.heads[0]!.caseId, 'pivot');
  return A.actAdvance(s);
}

/** From any state to Apply: settle the red thread with Keep one, set every later head aside, skip the workshop. */
function toApply(s: A.PlayState): A.PlayState {
  for (let i = 0; i < 40 && A.selectScreen(s).kind !== 'apply'; i++) {
    const sc = A.selectScreen(s);
    if (sc.kind === 'campfire') {
      const red = sc.view.threads.find((t) => t.color === 'red');
      if (red) s = A.actSettle(s, red.id, { kind: 'keep', keep: red.newer! });
    }
    if (sc.kind === 'room' || sc.kind === 'event') {
      if (sc.view.kind === 'workshop') s = A.actSkip(s).state;
      else if (sc.view.phase === 'judge') for (const h of sc.view.heads) s = A.actStamp(s, h.caseId, 'not-a-problem');
    }
    if (sc.kind === 'boss') for (let k = 0; k < 10 && A.selectBoss(s).current; k++) s = A.actBossNext(A.actBossStamp(s, A.selectBoss(s).current!, 'not-a-problem'));
    s = A.actAdvance(s);
  }
  if (A.selectScreen(s).kind !== 'apply') throw new Error('never reached Apply');
  return s;
}

/** A Web Storage stand-in. */
function memStore(): Store & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

describe('the mirror: one truth per number, with its denominator (gate fix 8)', () => {
  test('the same instruction in several sessions counts room 1 (it read 0): one instruction, five sessions, two held for the boss', () => {
    expect(an.mirror.directives).toEqual({ repeated: 1, sessions: 5, heldBack: 2 });
    const room = an.rooms.find((r) => r.family === 'directive')!;
    // The room shows its three in-room sessions; the mirror counts them with the two withheld ones, and says so.
    expect(new Set(room.episodes.map((e) => e.sessionId)).size).toBe(3);
    expect(room.withheld.length).toBe(2);
    expect(mirrorRows(an.mirror).find(([k]) => k === 'The same instruction in several sessions')![1]).toBe('1 · in 5 of 12 sessions (2 of those cases held for the boss)');
  });

  test('stops: the character line and the stops row read the same counts (6 of 7)', () => {
    expect(an.mirror.character!.line).toBe('6 of 7 stops drew a line · 5 of them cut off a full test run');
    expect(mirrorRows(an.mirror).find(([k]) => k.startsWith('Stops'))![1]).toBe('7 · 7 followed by your next message: 6 drew a line, 1 changed the plan, 0 other');
  });

  test('tool calls cut off by a stop count as interrupted, no result, and their receipts say so', () => {
    expect(an.mirror.calls).toMatchObject({ total: 47, withResult: 40, interrupted: 7 });
    expect(mirrorRows(an.mirror).find(([k]) => k === 'Tool calls')![1]).toBe('47 · 40 with a recorded result · 7 interrupted, no result');
    const stops = an.episodes.filter((e) => e.type === 'interrupt');
    expect(stops.every((e) => e.receipt.result === 'interrupted, no result')).toBe(true);
  });

  test('the act line counts the places the list shows (8), not the rooms found (5)', () => {
    expect(an.route.nodes.length).toBe(8);
    expect(actLine(an)).toBe('8 places: 5 rooms in 4 places, 2 campfires, the boss, Apply.');
  });
});

describe('a click does what a drag does (stall A)', () => {
  test('with the beast reading on screen, a tap on a head plays the selected card at once (no second confirm)', () => {
    let s0 = fresh();
    for (const h of A.selectRoom(s0)!.heads) s0 = A.actStamp(s0, h.caseId, 'issue');
    const c = new Controller(s0, null, { viewport: { w: 1440, h: 900 } });
    c.api.deal();
    const room = c.screen();
    if (room.kind !== 'room') throw new Error('not a room');
    // Dealing selects the first card and shows its beast reading.
    expect(c.ui.selected).toBe(room.view.hand[0]!.id);
    c.api.tapTarget({ kind: 'head', caseId: room.view.heads[1]!.caseId });
    const after = c.screen();
    if (after.kind !== 'room') throw new Error('not a room');
    expect(after.view.phase).toBe('done');
    expect(after.view.beast.pips.addressed).toBe(3);
  });

  test('at the fire, a tap on another card while one is selected stacks it (the red pair proposes a settlement)', () => {
    const c = new Controller(toFirstFire(), null, { viewport: { w: 1440, h: 900 } });
    const fire = c.screen();
    if (fire.kind !== 'campfire') throw new Error('not the fire');
    const red = fire.view.threads.find((t) => t.color === 'red')!;
    c.api.select(red.members[0]!);
    c.api.tapTarget({ kind: 'card', cardId: red.members[1]! });
    expect(c.ui.pending).toMatchObject({ kind: 'stack', threadId: red.id });
    expect(c.ui.notice).toBeNull();
  });
});

describe('safe defaults and honest lines at the fire (gate fixes 10, 14, 16; stall D)', () => {
  test('the red thread is pre-selected; its newer member is the card played this act', () => {
    const s = toFirstFire();
    const v = A.selectCampfire(s);
    const red = v.threads.find((t) => t.color === 'red')!;
    expect(v.focusedPair!.threadId).toBe(red.id);
    const played = A.selectRoom(s, an.rooms.find((r) => r.family === 'directive')!.key)!.result!.cardId!;
    expect(red.newer).toBe(played);
  });

  test('a settlement that removes a line puts it in the ash, like a burn', () => {
    let s = toFirstFire();
    const red = A.selectCampfire(s).threads.find((t) => t.color === 'red')!;
    s = A.actSettle(s, red.id, { kind: 'keep', keep: red.newer! });
    const v = A.selectCampfire(s);
    expect(v.ashCount).toBe(1);
    expect(v.ash[0]!.id).toBe(red.members.find((m) => m !== red.newer)!);
    // Restoring it brings the red thread back: nothing about the disagreement is hidden.
    s = A.actRestore(s, v.ash[0]!.id);
    expect(A.selectCampfire(s).threads.some((t) => t.color === 'red')).toBe(true);
  });

  test('a preview names only the files whose bytes change; the gold thread carries its shared words, not a percentage', () => {
    const s = toFirstFire();
    const uv = A.selectCampfire(s).threads.find((t) => t.color === 'gold' && t.members.length === 3)!;
    expect(uv.reason).not.toMatch(/%/);
    expect(uv.shared!.words).toEqual(expect.arrayContaining(['uv', 'pip']));
    const pv = A.selectChangePreview(s, { threadId: uv.id })!;
    expect(pv.changed.length).toBeGreaterThan(0);
    // A file whose weight moves is always named; a file named is one whose bytes the merge rewrites.
    if (pv.ghost.claude.delta !== 0) expect(pv.changed).toContain('CLAUDE.md');
    if (pv.ghost.codex.delta !== 0) expect(pv.changed).toContain('AGENTS.md');
    const red = A.selectCampfire(s).threads.find((t) => t.color === 'red')!;
    const full = A.selectCampfire(s).lanes.codex.find((k) => k.inspector.exact === TUTORIAL.redLink.onLine)!;
    const exc = A.selectChangePreview(s, { threadId: red.id, resolution: { kind: 'exception', on: full.id, text: TUTORIAL.redLink.text, when: {} } })!;
    expect(exc.changed).toEqual(['AGENTS.md']);
  });
});

describe('the room says what it did and how its drafts differ (gate fixes 4, 15; stall H)', () => {
  test('room 1: the local words get a line on the global scope chip; the clear line after the play', () => {
    const s0 = fresh();
    expect(A.selectRoom(s0)!.scope.hint).toBe('Your words sound local (“takes ten minutes here”); the line is global. Change the scope chip to keep it to one project.');
    let s = judgeAndDeal(s0);
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    expect(A.selectRoom(s)!.clear).toBe('3 cases now have a proposed line. Nothing is prevented; lines land only when you Apply.');
    // Confirming a project removes the hint.
    const p = A.selectRoom(s0)!.scope.projects[0]!;
    expect(A.selectRoom(A.actConfirmProject(s0, A.selectRoom(s0)!.roomKey, p.key))!.scope.hint).toBeNull();
  });

  test('a hand of two or more names what the agent does next for each draft', () => {
    let s = toFirstFire();
    s = A.actAdvance(s);
    let found: string | null = null;
    for (let i = 0; i < 4 && A.selectScreen(s).kind === 'room' && !found; i++) {
      s = judgeAndDeal(s);
      const v = A.selectRoom(s)!;
      if (v.hand.length >= 2) found = v.handDiffers;
      s = v.hand.length ? A.actPlay(s, v.hand[0]!.id, 'beast').state : A.actSkip(s).state;
      s = A.actAdvance(s);
    }
    expect(found).toMatch(/^These (two|three) differ in what the agent does next: .+\.$/);
  });
});

describe('the second visit: the receipt and the stable line ids, kept only with consent (spec §7)', () => {
  test('a record round-trips through storage; a broken one reads as none; forget removes it', () => {
    const store = memStore();
    expect(loadApply(store)).toBeNull();
    const r = recordOf({ bundleId: 'b1', ts: '2026-10-07T04:00:00.000Z', files: [{ root: 'claude', rel: 'CLAUDE.md', kind: 'global', created: false, beforeSha: 'a', afterSha: 'b' }] }, [{ file: 'CLAUDE.md', ids: ['x1', 'x2'] }], false, new Date('2026-10-07T04:01:00Z'));
    expect(saveApply(store, r)).toBe(true);
    expect(loadApply(store)).toEqual(r);
    store.setItem(REMEMBER_KEY, '{"version":1,"bundleId":3}');
    expect(loadApply(store)).toBeNull();
    store.setItem(REMEMBER_KEY, 'not json');
    expect(loadApply(store)).toBeNull();
    saveApply(store, r);
    forgetApply(store);
    expect(store.map.size).toBe(0);
    expect(linesFromLastApply(r, 'CLAUDE.md', ['x2', 'y'])).toBe(1);
    // Nothing from a session log is in the record.
    expect(Object.keys(r).sort()).toEqual(['bundleId', 'files', 'lines', 'sample', 'savedAt', 'version', 'writtenAt']);
  });

  let tmp: string;
  let roots: Root[];
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'errata-p3-'));
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

  test('after a verified Apply the view offers to keep the receipt; keeping stores the ids now in the files, and a second visit reads the same ids back', async () => {
    const store = memStore();
    const port: A.ApplyPort = {
      roots: () => roots,
      needs: () => ({ claude: false, codex: false, agents: true }),
      readSkill: async () => null,
      ensureWritable: async () => true,
      grant: async () => null,
      canWrite: () => true,
      remember: (r) => (r ? saveApply(store, r) : forgetApply(store)),
      remembered: (id) => loadApply(store)?.bundleId === id,
    };
    let s = judgeAndDeal(fresh());
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    // Settle the red thread, then go straight to Apply.
    s = toApply(s);
    const c = new Controller(s, port, { viewport: { w: 1440, h: 900 } });
    await c.api.apply.prepare();
    expect((c.screen() as { view: { remember: unknown } }).view.remember).toEqual({ offered: false, saved: false });
    await c.api.apply.seal();
    const v = () => {
      const sc = c.screen();
      if (sc.kind !== 'apply') throw new Error('not Apply');
      return sc.view;
    };
    expect(v().result!.status).toBe('written');
    // Off until the player says so.
    expect(v().remember).toEqual({ offered: true, saved: false });
    expect(store.map.size).toBe(0);
    c.api.apply.remember(true);
    expect(v().remember).toEqual({ offered: true, saved: true });
    const kept = loadApply(store)!;
    expect(kept.bundleId).toBe(v().result!.bundle!);
    // The second visit: the files as written carry the same ids, so every kept line is recognised.
    const claude = new Uint8Array(await readFile(join(tmp, 'home/.claude/CLAUDE.md')));
    const ids = parseGlobal(claude).managed.map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(linesFromLastApply(kept, 'CLAUDE.md', ids)).toBe(ids.length);
    // Reading the written file again yields the same managed ids: the ids are stable across visits.
    expect(newDeck(claude, null).imported.filter((k) => ids.includes(k.id)).map((k) => k.id).sort()).toEqual([...ids].sort());
    c.api.apply.remember(false);
    expect(v().remember).toEqual({ offered: true, saved: false });
    expect(loadApply(store)).toBeNull();
  });
});

describe('a browser without folder access exports the blocks (Exported, not applied)', () => {
  test('Apply shows each file block from its begin marker to its end marker, asks for no folder, and cannot seal', () => {
    let s = judgeAndDeal(fresh());
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    s = toApply(s);
    const port = { needs: () => ({ claude: true, codex: true, agents: true }), canWrite: () => false };
    const v = A.selectApply(s, port);
    expect(v.exported!.map((f) => f.file)).toEqual(['CLAUDE.md', 'AGENTS.md']);
    for (const f of v.exported!) {
      expect(f.text.startsWith(BEGIN)).toBe(true);
      expect(f.text.trimEnd().endsWith(END)).toBe(true);
      expect(f.text).toContain('run only the test file for the change');
      expect(f.download).toMatch(/^(CLAUDE|AGENTS)-errata-block\.md$/);
    }
    expect(v.blockers.some((b) => b.kind === 'grant')).toBe(false);
    expect(v.canSeal).toBe(false);
    // With folder access nothing is exported.
    expect(A.selectApply(s, { ...port, canWrite: () => true }).exported).toBeNull();
  });
});

describe('a seal ends the gesture', () => {
  test('after a settlement the selection clears, so the next tap at the fire starts a new stack', () => {
    const c = new Controller(toFirstFire(), null, { viewport: { w: 1440, h: 900 } });
    const fire = c.screen();
    if (fire.kind !== 'campfire') throw new Error('not the fire');
    const red = fire.view.threads.find((t) => t.color === 'red')!;
    c.api.select(red.members[0]!);
    c.api.tapTarget({ kind: 'card', cardId: red.members[1]! });
    c.api.campfire.settle(red.id, { kind: 'keep', keep: red.newer! });
    expect(c.ui.selected).toBeNull();
    const uv = (c.screen() as { view: { threads: { id: string; color: string; members: string[] }[] } }).view.threads.find((t) => t.color === 'gold' && t.members.length === 3)!;
    c.api.select(uv.members[0]!);
    c.api.tapTarget({ kind: 'card', cardId: uv.members[1]! });
    expect(c.ui.pending).toMatchObject({ kind: 'stack', threadId: uv.id });
  });
});

describe('numbers the second cold run could not trace', () => {
  test('the first Skill card adds its line and the workflows heading; the heading counts as block header, never an unnamed other', () => {
    let s = judgeAndDeal(fresh());
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    for (let i = 0; i < 12 && !(A.selectScreen(s).kind === 'room' && A.selectRoom(s)!.kind === 'workshop'); i++) {
      const sc = A.selectScreen(s);
      if (sc.kind === 'room' || sc.kind === 'event') for (const h of sc.view.heads) s = A.actStamp(s, h.caseId, 'not-a-problem');
      s = A.actAdvance(s);
    }
    s = A.actDeal(s);
    const mint = A.selectRoom(s)!.hand.find((c) => c.type === 'skill')!;
    const g = mint.playPreview!.ghost.claude;
    expect(g.line).toBe(mint.weight);
    expect(g.other).toBe(0);
    expect(g.blockHeader).toBeGreaterThan(0);
    expect(g.delta).toBe(g.line + g.blockHeader);
    expect(g.text).toBe(`+${g.line} tok (+${g.blockHeader} header, once)`);
  });

  test('the boss tally says what its unknown count counts', () => {
    const b = A.selectBoss(A.actAdvance(A.actAdvance(toFirstFire())));
    const line = A.selectApply(toApply(toFirstFire())).summary.lines.find((l) => l.includes('not yet judged'));
    expect(line).toMatch(/\d+ lines? not yet judged: '[^']+…'/);
    expect(b).toBeDefined();
  });
});
