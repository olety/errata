// Safety regressions (mechanics §12, the hour-36 list): one test per line, each through the play-loop adapter on the
// synthetic sample and isolated folder grants only. Where a deeper engine test exists, the test cites it and asserts
// only the adapter-level outcome.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDeck } from '../src/deck/deck';
import { BEGIN } from '../src/deck/file';
import { validateSkillFile } from '../src/deck/skill';
import { nodeRoot } from '../src/apply/node-root';
import type { Root } from '../src/apply/types';
import * as A from '../src/ui/playloop/adapter';
import { SAMPLE_ROOT, sampleAgentsMd, sampleAnalysis, sampleClaudeMd, sampleManifest } from './helpers';

let fresh: () => A.PlayState;
let injectedText: string[];
const dirs: string[] = [];

beforeAll(async () => {
  const analysis = await sampleAnalysis();
  fresh = () => A.createPlayState({ analysis, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true });
  const manifest = sampleManifest();
  const injected = manifest.expected_outcomes.find((e) => e.expects.excluded_system_turns)!;
  const session = manifest.sessions.find((s) => s.session === injected.session)!;
  const source = await Bun.file(join(SAMPLE_ROOT, session.file)).text();
  injectedText = injected.expects.cards_containing as string[];
  expect(injectedText.length).toBeGreaterThan(0);
  for (const text of injectedText) expect(source).toContain(text);
});
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function judgeAndDeal(s: A.PlayState): A.PlayState {
  for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, 'issue');
  return A.actDeal(s);
}

function firstFire(): A.PlayState {
  let s = judgeAndDeal(fresh());
  s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
  s = A.actAdvance(s);
  s = A.actStamp(s, A.selectRoom(s)!.heads[0]!.caseId, 'pivot');
  return A.actAdvance(s);
}

/** Settle conflicts, set later heads aside, and optionally forge the workshop's Skill. */
function toApply(s: A.PlayState, skill = false): A.PlayState {
  for (let i = 0; i < 40 && A.selectScreen(s).kind !== 'apply'; i++) {
    const sc = A.selectScreen(s);
    if (sc.kind === 'campfire') for (const red of sc.view.threads.filter((t) => t.color === 'red')) s = A.actSettle(s, red.id, { kind: 'keep', keep: red.newer! });
    if ((sc.kind === 'room' || sc.kind === 'event') && sc.view.phase === 'judge') {
      if (sc.view.kind === 'workshop') {
        s = skill ? A.actDeal(s) : A.actSkip(s).state;
        if (skill) s = A.actPlay(s, A.selectRoom(s)!.hand.find((c) => c.type === 'skill')!.id, 'beast').state;
      } else for (const h of sc.view.heads) s = A.actStamp(s, h.caseId, 'not-a-problem');
    }
    if (sc.kind === 'boss') while (A.selectBoss(s).current) s = A.actBossNext(A.actBossStamp(s, A.selectBoss(s).current!, 'not-a-problem'));
    s = A.actAdvance(s);
  }
  if (A.selectScreen(s).kind !== 'apply') throw new Error('never reached Apply');
  return s;
}

/** Every write is recorded; fault injection counts target writes, not recovery-bundle bookkeeping. */
async function samplePort(failSecond = false) {
  const dir = await mkdtemp(join(tmpdir(), 'errata-safety-'));
  dirs.push(dir);
  await cp(join(SAMPLE_ROOT, 'home'), join(dir, 'home'), { recursive: true });
  const file = (lane: 'claude' | 'codex', rel: string) => join(dir, 'home', lane === 'claude' ? '.claude' : '.codex', rel);
  const raw: Root[] = [
    await nodeRoot('claude', join(dir, 'home/.claude')),
    await nodeRoot('codex', join(dir, 'home/.codex')),
    await nodeRoot('claude-skills', join(dir, 'home/.claude/skills')),
    await nodeRoot('codex-skills', join(dir, 'home/.agents/skills')),
    await nodeRoot('backup', join(dir, 'home/.claude')),
  ];
  const writes: string[] = [];
  let targets = 0;
  const roots: Root[] = raw.map((r) => ({ ...r, write: async (rel, bytes) => {
    writes.push(`${r.id}/${rel}`);
    if (r.id !== 'backup' && ++targets === 2 && failSecond) throw new Error('second target write failed');
    await r.write(rel, bytes);
  } }));
  const port: A.ApplyPort = {
    roots: () => roots,
    needs: () => ({ claude: false, codex: false, agents: false }),
    readSkill: async (root, rel) => root === 'codex-legacy-skills' ? null : roots.find((r) => r.id === root)!.read(rel),
    ensureWritable: async () => true,
    grant: async () => ({ claude: await roots[0]!.read('CLAUDE.md'), codex: await roots[1]!.read('AGENTS.md'), override: await roots[1]!.read('AGENTS.override.md'), loaded: { claude: true, codex: true } }),
  };
  return { dir, file, port, writes };
}

async function prepare(port: A.ApplyPort, skill = false): Promise<A.PlayState> {
  const s = await A.actPrepareApply(toApply(firstFire(), skill), port);
  expect(A.selectApply(s, port).blockers).toEqual([]);
  expect(A.selectApply(s, port).canSeal).toBe(true);
  return s;
}

function visibleText(s: A.PlayState): string {
  return JSON.stringify(s.rooms.map((r) => A.selectRoom(s, r.key))).toLowerCase();
}

describe('safety regressions (mechanics §12, hour-36 list)', () => {
  test('a wrong agent cannot cover (a Claude-only line never binds or covers a Codex case: the head stays standing, its fail reason names the file)', () => {
    // deep test: tests/sample.test.ts › 'S12: a later Codex case of the S01 directive, withheld; a global card for both agents covers it, a Claude-only card does not'
    const s = judgeAndDeal(fresh());
    const v = A.selectRoom(s)!;
    const id = v.hand[0]!.id;
    const codex = v.heads.filter((h) => h.tag.agent === 'codex').map((h) => h.caseId);
    expect(codex.length).toBe(2);
    const preview = A.selectDrag(s, id, { kind: 'book', lane: 'claude' });
    expect(preview.heads.filter((h) => codex.includes(h.caseId)).map((h) => [h.glow, h.word])).toEqual([[false, 'not in AGENTS.md'], [false, 'not in AGENTS.md']]);
    const played = A.actPlay(s, id, 'claude');
    expect(played.result.standing).toEqual(codex);
    expect(played.result.accepted.some((id) => codex.includes(id))).toBe(false);
    for (const caseId of codex) {
      expect(A.selectRoom(played.state)!.heads.find((h) => h.caseId === caseId)!.state).toBe('standing');
      expect(A.selectCovered(played.state).has(caseId)).toBe(false);
      expect(A.actAcceptOnHead(played.state, id, caseId)).toBe(played.state);
    }
  });

  test("a wrong project cannot cover (a line scoped to one project leaves the other project's head standing)", () => {
    // deep test: tests/sample.test.ts › 'S10: a project-scoped boundary: covers P1, never P2; the line names the frozen and the new directory'
    let s = fresh();
    const v = A.selectRoom(s)!;
    const project = v.scope.projects.find((p) => p.label === 'pyramid')!;
    s = judgeAndDeal(A.actConfirmProject(s, v.roomKey, project.key));
    const id = A.selectRoom(s)!.hand[0]!.id;
    const other = v.heads.find((h) => h.tag.project === 'datalad')!.caseId;
    expect(A.selectDrag(s, id, { kind: 'beast' }).heads.find((h) => h.caseId === other)).toMatchObject({ glow: false, word: 'datalad' });
    const played = A.actPlay(s, id, 'beast');
    expect(played.result.standing).toEqual([other]);
    expect(A.selectRoom(played.state)!.heads.find((h) => h.caseId === other)!.state).toBe('standing');
    expect(A.selectCovered(played.state).has(other)).toBe(false);
    expect(A.actAcceptOnHead(played.state, id, other)).toBe(played.state);
  });

  test('a pivot cannot become a failure or a rule (a head stamped pivot is never counted as confirmed, never bound, and an event room deals no rule from it)', () => {
    // deep test: tests/sample.test.ts › 'S02: an innocent pivot is a neutral event, never a monster'
    // deep test: tests/episodes.test.ts › 'a pivot is detected as an episode but starts unreviewed; it never counts until the player says issue'
    let s = judgeAndDeal(fresh());
    const id = A.selectRoom(s)!.hand[0]!.id;
    s = A.actAdvance(A.actPlay(s, id, 'beast').state);
    const pivot = A.selectRoom(s)!.heads[0]!.caseId;
    s = A.actStamp(s, pivot, 'pivot');
    const deck = s.deck;
    expect(A.actDeal(s)).toBe(s);
    expect(A.selectRoom(s)).toMatchObject({ kind: 'event', hand: [], unavailable: [], canDeal: false, beast: { pips: { confirmed: 0, addressed: 0 } } });
    expect(A.actAcceptOnHead(s, id, pivot)).toBe(s);
    const skipped = A.actSkip(s);
    expect(skipped.result.bound).toEqual([]);
    expect(A.selectRoom(skipped.state)!.heads[0]!.state).toBe('heron');
    expect(A.selectCovered(skipped.state).has(pivot)).toBe(false);
    expect(A.selectPiles(skipped.state).open.some((p) => p.caseId === pivot)).toBe(false);
    expect(skipped.state.deck).toBe(deck);
  });

  test("injected system text cannot become a rule (no card face, receipt or dealt draft in any room carries the sample's injected text; find the injected session in public/sample/manifest.json)", () => {
    // deep test: tests/sample.test.ts › 'S04: injected text is excluded and never reaches a card'
    // deep test: tests/episodes.test.ts › 'NEGATIVE: an injected summary never becomes an episode quote'
    let s = fresh();
    let dealt = 0;
    const clean = () => { for (const text of injectedText) expect(visibleText(s)).not.toContain(text.toLowerCase()); };
    clean();
    for (let i = 0; i < 40 && A.selectScreen(s).kind !== 'apply'; i++) {
      const sc = A.selectScreen(s);
      if (sc.kind === 'room' || sc.kind === 'event') {
        s = judgeAndDeal(s);
        dealt += A.selectRoom(s)!.hand.length;
        clean();
        s = A.actSkip(s).state;
      }
      if (sc.kind === 'boss') while (A.selectBoss(s).current) s = A.actBossNext(A.actBossStamp(s, A.selectBoss(s).current!, 'not-a-problem'));
      s = A.actAdvance(s);
    }
    expect(A.selectScreen(s).kind).toBe('apply');
    expect(dealt).toBeGreaterThan(0);
    clean();
  });

  test('an exception survives fusion (fuse the force-push pair through actFuse; the exported CLAUDE.md/AGENTS.md text still carries the exception clause)', async () => {
    // deep test: tests/sample.test.ts › 'the two force-push lines fuse and the exception survives as visible text'
    const s = firstFire();
    const fire = A.selectCampfire(s);
    const cards = [...fire.lanes.claude, ...fire.lanes.both, ...fire.lanes.codex];
    const pair = fire.threads.find((t) => t.color === 'gold' && t.members.every((id) => cards.find((c) => c.id === id)!.inspector.exact.includes('force-push')))!;
    const fused = A.actFuse(s, pair.id, pair.autoText!);
    expect(fused.deck).not.toBe(s.deck);
    const p = await samplePort();
    const applied = await A.actSeal(await A.actPrepareApply(toApply(fused), p.port), p.port);
    expect(A.selectApply(applied, p.port).result!.status).toBe('written');
    // The pair is Claude-only prose outside the managed block; check the complete exported files through Apply.
    expect(await readFile(p.file('claude', 'CLAUDE.md'), 'utf8')).toContain('except to your own feature branch right after a rebase');
    expect(await readFile(p.file('codex', 'AGENTS.md'), 'utf8')).not.toContain('force-push');
    expect(A.selectCampfire(fused).lanes.claude.filter((c) => c.inspector.exact.includes('force-push'))).toHaveLength(1);
  });

  test("an external edit blocks a stale Apply (change a target file in the port's folder after actPrepareApply; actSeal writes nothing and the apply view shows a blocker; nothing reads Written)", async () => {
    // deep test: tests/apply.test.ts › 'a stale baseline blocks Apply with no writes'
    const p = await samplePort();
    let s = await prepare(p.port);
    const external = Buffer.from('Edited elsewhere after the diff.\n');
    await writeFile(p.file('claude', 'CLAUDE.md'), external);
    s = await A.actSeal(s, p.port);
    const v = A.selectApply(s, p.port);
    expect(p.writes).toEqual([]);
    expect(v.result!.status).toBe('stale');
    expect(v.blockers).toContainEqual({ kind: 'stale', text: 'Changed since the diff: CLAUDE.md.', select: null });
    expect(v.canSeal).toBe(false);
    expect(v.stamps.written).toBe('failed');
    expect(v.result!.text).not.toContain('Written');
    expect(v.result!.files.every((f) => f.status === 'not-attempted')).toBe(true);
    expect(await readFile(p.file('claude', 'CLAUDE.md'))).toEqual(external);
  });

  test('a partial failure never shows Written (a port whose second write fails: the ink state is never Written and the view lists the changed files for restoration)', async () => {
    // deep test: tests/apply.test.ts › 'partial failure stops, journals the changed files and restores just that subset'
    const p = await samplePort(true);
    const s = await A.actSeal(await prepare(p.port), p.port);
    const v = A.selectApply(s, p.port);
    expect(v.result!.status).toBe('partial');
    expect(p.writes.filter((w) => !w.startsWith('backup/'))).toEqual(['claude/CLAUDE.md', 'codex/AGENTS.md']);
    expect(v.stamps.written).toBe('failed');
    expect(v.result!.text).not.toContain('Written');
    expect(v.footer).toBeNull();
    expect(v.result!.files).toEqual([{ path: 'CLAUDE.md', status: 'written-verified' }, { path: 'AGENTS.md', status: 'failed' }]);
    expect(v.canUndo).toBe(true);
    expect(await readFile(p.file('codex', 'AGENTS.md'))).toEqual(Buffer.from(sampleAgentsMd()));
  });

  test('reapplication creates no duplicate block (Apply, then Apply again with the same deck: one deck:begin marker per file, and the second run writes nothing)', async () => {
    // deep test: tests/apply.test.ts › 'identical reapplication performs no write and creates no bundle'
    // deep test: tests/deck.test.ts › 're-rendering replaces the block in place: no duplicate block, suffix kept byte-for-byte'
    const p = await samplePort();
    let s = await A.actSeal(await prepare(p.port), p.port);
    expect(A.selectApply(s, p.port).result!.status).toBe('written');
    const before = p.writes.length;
    s = await A.actSeal(await A.actPrepareApply(s, p.port), p.port);
    expect(A.selectApply(s, p.port).result).toMatchObject({ status: 'unchanged', bundle: null });
    expect(p.writes.slice(before)).toEqual([]);
    for (const [lane, file] of [['claude', 'CLAUDE.md'], ['codex', 'AGENTS.md']] as const) {
      expect((await readFile(p.file(lane, file), 'utf8')).split(BEGIN).length - 1).toBe(1);
    }
  });

  test("a fixture Skill is discoverable at both roots (after Apply of the sample's Skill card, SKILL.md exists under both the claude skills root and the agents skills root of the port, and its frontmatter parses with validateSkillFile)", async () => {
    // deep test: tests/skill.test.ts › 'plans both roots, either root or none, with skill bodies'
    // deep test: tests/campfire.test.ts › 'a Skill is built from the workflow room its card came from, never another one'
    const p = await samplePort();
    const s = await A.actSeal(await prepare(p.port, true), p.port);
    const v = A.selectApply(s, p.port);
    expect(v.result!.status).toBe('written');
    const skill = v.diffs.find((d) => d.kind === 'skill')!;
    expect(skill.path).toBe('verify-change/SKILL.md');
    for (const folder of ['.claude', '.agents']) {
      const source = await readFile(join(p.dir, 'home', folder, 'skills', skill.path), 'utf8');
      // The adapter has no Skill-file parser; validate the actual granted-root bytes with the narrow engine validator.
      expect(validateSkillFile(source, 'verify-change')).toEqual([]);
    }
    expect(p.writes).toEqual(expect.arrayContaining(['claude-skills/verify-change/SKILL.md', 'codex-skills/verify-change/SKILL.md']));
  });

  test('AGENTS.override.md blocks the Codex lane (a non-empty override in the codex folder: the Codex book shows blocked and Apply does not write AGENTS.md)', async () => {
    // deep test: tests/deck.test.ts › 'a non-empty AGENTS.override.md blocks the Codex lane; the override is never a target'
    const p = await samplePort();
    const override = Buffer.from('Use these Codex instructions instead.\n');
    await writeFile(p.file('codex', 'AGENTS.override.md'), override);
    let s = await A.actGrant(toApply(firstFire()), p.port, 'codex');
    expect(A.selectBooks(s).find((b) => b.lane === 'codex')!.blocked).toContain('AGENTS.override.md');
    expect(A.selectApply(s, p.port).diffs.find((d) => d.label === 'AGENTS.md')!.blocker).toContain('AGENTS.override.md');
    expect(A.selectApply(s, p.port).canSeal).toBe(true);
    s = await A.actSeal(s, p.port);
    expect(A.selectApply(s, p.port).result!.status).toBe('written');
    expect(p.writes).toContain('claude/CLAUDE.md');
    expect(p.writes).not.toContain('codex/AGENTS.md');
    expect(p.writes).not.toContain('codex/AGENTS.override.md');
    expect(await readFile(p.file('codex', 'AGENTS.md'))).toEqual(Buffer.from(sampleAgentsMd()));
    expect(await readFile(p.file('codex', 'AGENTS.override.md'))).toEqual(override);
  });

  test("the Notes block cannot be stacked or cut (the sample's sealed protected Notes line: actFuse/actCut/stack refuse it and the deck is unchanged)", () => {
    // deep test: tests/playloop-p2.test.ts › 'the sealed card never joins a gold or red thread, and every campfire change refuses it'
    const s = firstFire();
    const fire = A.selectCampfire(s);
    const notes = fire.lanes.claude.find((c) => c.inspector.exact === 'Monorepo tooling lives under tools/. Ask before touching CI config.')!;
    const other = fire.lanes.claude.find((c) => !c.sealed)!;
    expect(notes).toMatchObject({ type: 'protected', sealed: true });
    expect(fire.threads.some((t) => t.members.includes(notes.id))).toBe(false);
    // Sealed text has no fuse thread; an attempted pair id must leave the proposal unchanged.
    expect(A.actFuse(s, [notes.id, other.id].sort().join('+'), other.inspector.exact)).toBe(s);
    expect(A.actCut(s, notes.id)).toBe(s);
    expect(A.selectChangePreview(s, { cutId: notes.id })!.refused).toBe(A.SEALED);
    expect(A.selectDrag(s, notes.id, { kind: 'card', cardId: other.id }).refused).toBe(A.SEALED);
    expect(A.selectDrag(s, other.id, { kind: 'card', cardId: notes.id }).refused).toBe(A.SEALED);
    expect(A.selectCampfire(s).lanes).toEqual(fire.lanes);
  });

  test('Undo refuses when the target changed (after a Written Apply, edit CLAUDE.md externally; actUndo leaves it byte-for-byte and reports it)', async () => {
    // deep test: tests/apply.test.ts › 'undo never clobbers an external edit: it reports a restore diff instead'
    const p = await samplePort();
    let s = await A.actSeal(await prepare(p.port), p.port);
    expect(A.selectApply(s, p.port).result!.status).toBe('written');
    const external = Buffer.concat([await readFile(p.file('claude', 'CLAUDE.md')), Buffer.from('\nExternal edit after Apply.\n')]);
    await writeFile(p.file('claude', 'CLAUDE.md'), external);
    const before = p.writes.length;
    s = await A.actUndo(s, p.port);
    expect(await readFile(p.file('claude', 'CLAUDE.md'))).toEqual(external);
    expect(A.selectApply(s, p.port).undo!.files).toContainEqual({ path: 'CLAUDE.md', text: 'changed after Apply; nothing was overwritten', conflict: true });
    expect(p.writes.slice(before)).not.toContain('claude/CLAUDE.md');
  });
});
