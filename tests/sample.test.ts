// The synthetic sample through the real pipeline (spec §10): parser → episodes → rooms → route → cover, campfire,
// Apply and Undo. Every expectation comes from public/sample/manifest.json; a mismatch fails here, not in the UI.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/model';
import { allCalls } from '../src/model';
import { parseSessionFile } from '../src/parse/index';
import { analyse, type Analysis } from '../src/pipeline';
import type { Episode, InterruptEpisode, RepeatedCommandEpisode, EditSequenceEpisode, WorkflowEpisode } from '../src/episodes';
import { caseFor, type Room } from '../src/rooms';
import { draftCards } from '../src/deck/templates';
import { acceptMapping, setTaken, updateCard } from '../src/deck/card';
import type { Card, Case } from '../src/deck/types';
import { cover } from '../src/cover';
import { deckExportMap, newDeck, presentCards, renderLanes, withCards, type DeckState } from '../src/deck/deck';
import { applyFuse, conflicts, fuseSuggestions, previewFuse, resolveConflict, sharpenSuggestions } from '../src/deck/campfire';
import { applyTargets } from '../src/deck/skill-plan';
import { weigh, text as utf8 } from '../src/deck/file';
import { applyPlan, makePlan, sameBytes, undoBundle } from '../src/apply/engine';
import { nodeRoot } from '../src/apply/node-root';

const ROOT = join(import.meta.dir, '..', 'public', 'sample');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  label: string;
  sessions: { session: string; session_id: string; agent: 'claude' | 'codex'; project: string; file: string }[];
  projects: Record<string, { name: string }>;
  expected_outcomes: { session: string; expects: Record<string, unknown> }[];
  deck_assertions: Record<string, unknown>;
  tutorial_assertions: { character: string; display: string; expected_all_interventions: number; expected_boundary_interventions: number; expected_session_count: number; expected_full_suite_cutoffs: number };
};
const expects = (sid: string) => manifest.expected_outcomes.find((x) => x.session === sid)!.expects as Record<string, any>;
const CLAUDE_MD = readFileSync(join(ROOT, 'home/.claude/CLAUDE.md'));
const AGENTS_MD = readFileSync(join(ROOT, 'home/.codex/AGENTS.md'));

let A: Analysis;
const byLabel = new Map<string, Session>();
const labelOf = new Map<string, string>();

beforeAll(async () => {
  const sessions: Session[] = [];
  for (const m of manifest.sessions) {
    const s = await parseSessionFile({ rel: m.file.replace(/^home\/\.(?:claude|codex)\//, ''), blob: Bun.file(join(ROOT, m.file)) });
    sessions.push(s);
    byLabel.set(m.session, s);
    labelOf.set(s.id, m.session);
  }
  A = analyse(sessions, { importedCards: newDeck(CLAUDE_MD, AGENTS_MD).imported.length });
});

const eps = (sid: string) => A.episodes.filter((e) => e.sessionId === byLabel.get(sid)!.id);
const roomOf = (e: Episode) => A.rooms.find((r) => r.episodes.includes(e) || r.withheld.includes(e));
const projectKey = (p: string) => byLabel.get(manifest.sessions.find((s) => s.project === p)!.session)!.projectKey!;
const issue = (c: Case): Case => ({ ...c, disposition: 'issue' });
const directiveRoom = () => roomOf(eps('S01').find((e) => e.type === 'interrupt')!)!;
const take = (card: Card, cases: Case[]) => setTaken(cases.reduce((k, c) => acceptMapping(k, c.id), card), true);
const deckWith = (cards: Card[]): DeckState => withCards(newDeck(CLAUDE_MD, AGENTS_MD), cards);
const coversIn = (d: DeckState, card: Card, c: Case) => cover(card, c, deckExportMap(d, renderLanes(d)));

describe('manifest: per-session expected outcomes', () => {
  test('the manifest is the synthetic sample and every session in it is parsed', () => {
    expect(manifest.label).toBe('synthetic sample');
    expect(manifest.sessions.length).toBe(manifest.tutorial_assertions.expected_session_count);
    expect(A.sessions.length).toBe(manifest.sessions.length);
  });

  test('S01: interrupt → directive is the anchor of the repeated-directive room, corroborated by S03 and S06', () => {
    const x = expects('S01');
    const e = eps('S01').find((e): e is InterruptEpisode => e.type === 'interrupt')!;
    expect(x.episode_type).toBe(1);
    expect(e.receipt.quote).toBe(x.receipt);
    const r = roomOf(e)!;
    expect(r.family).toBe('directive');
    expect(x.family).toBe('repeated genuine directive');
    expect(r.anchor).toBe(e);
    const inRoom = new Set(r.episodes.map((y) => labelOf.get(y.sessionId)));
    for (const c of x.corroborating_sessions as string[]) expect(inRoom.has(c)).toBe(true);
    // The route opens on this room.
    expect(A.route.nodes[0]!.rooms[0]).toBe(r.key);
  });

  test('S02: an innocent pivot is a neutral event, never a monster', () => {
    const x = expects('S02');
    const e = eps('S02').find((e): e is InterruptEpisode => e.type === 'interrupt')!;
    expect(e.pivotHint).toBe(true);
    const r = roomOf(e)!;
    expect(r.kind).toBe('event');
    expect(draftCards(r)).toEqual([]);
    expect(x.disposition).toBe('pivot');
    const monsters = A.rooms.filter((rr) => rr.kind === 'encounter' && [...rr.episodes, ...rr.withheld].some((y) => y.sessionId === byLabel.get('S02')!.id));
    expect(monsters.length).toBe(x.monster_count);
    // A pivot disposition never covers, whatever the card.
    const card = take(draftCards(directiveRoom())[0]!, []);
    expect(cover(card, { ...caseFor(e, r), disposition: 'pivot' }, { claude: new Set([card.id]), codex: new Set([card.id]) }).covers).toBe(false);
  });

  test('S03: Codex turn_aborted pairs with the next user message; the patch inside exec is an edit; same directive room; card targets both; project P2; conflicts with the full-suite rule', () => {
    const x = expects('S03');
    const s = byLabel.get('S03')!;
    const e = eps('S03').find((e): e is InterruptEpisode => e.type === 'interrupt')!;
    expect(e.interrupt).toBe('turn_aborted');
    expect(e.receipt.quote).toStartWith('only run `test_json_overrides.py`');
    expect(allCalls(s).some((c) => c.name === 'exec' && c.kind === 'edit' && c.files.includes('test_json_overrides.py'))).toBe(x.patch_inside_exec);
    const r = roomOf(e)!;
    expect(r).toBe(directiveRoom());
    const [a] = draftCards(r);
    expect(a!.targets).toBe('both');
    expect((x.card_targets as string[]).sort()).toEqual(['claude', 'codex']);
    expect(e.projectLabel).toBe(manifest.projects[x.project as string]!.name);
    const deck = deckWith([take(a!, [])]);
    const red = conflicts(deck).find((c) => [c.a, c.b].includes(a!.id))!;
    const other = presentCards(deck).find((c) => c.id === (red.a === a!.id ? red.b : red.a))!;
    expect(other.text).toBe(x.conflict_with_rule);
  });

  test('S04: injected text is excluded and never reaches a card', () => {
    const x = expects('S04');
    const s = byLabel.get('S04')!;
    expect(s.turns.filter((t) => t.role === 'injected').length).toBe(x.excluded_system_turns);
    const texts = A.rooms.flatMap((r) => draftCards(r)).map((c) => c.text.toLowerCase());
    const hits = (x.cards_containing as string[]).filter((w) => texts.some((t) => t.includes(w)));
    expect(hits.length).toBe(x.count);
    expect(A.mirror.excluded.total).toBeGreaterThanOrEqual(x.excluded_system_turns);
  });

  test('S05: the same command failed three times identically; the install is the adjacent action', () => {
    const x = expects('S05');
    const e = eps('S05').find((e): e is RepeatedCommandEpisode => e.type === 'repeated-command')!;
    expect(x.episode_type).toBe(2);
    expect(e.failures.length).toBe(x.identical_command_error_count);
    expect(e.receipt.result).toContain(x.error_contains);
    expect(e.breaker).toBe(x.adjacent_action);
    expect(roomOf(e)!.family).toBe('repeated-command');
  });

  test('S06: third support for the directive; a shared card covers it, a Claude-only card leaves it open', () => {
    const x = expects('S06');
    const r = directiveRoom();
    expect(r.sessions).toBe(x.support_number);
    const e = eps('S06').find((e) => e.type === 'interrupt')!;
    const c = issue(caseFor(e, r));
    const shared = take(draftCards(r)[0]!, [c]);
    expect(shared.targets).toBe('both');
    expect(coversIn(deckWith([shared]), shared, c).covers).toBe(true);
    const claudeOnly = take(updateCard(draftCards(r)[0]!, { targets: (x.remains_open_if_targets as string[])[0] as 'claude' }), [c]);
    const res = coversIn(deckWith([claudeOnly]), claudeOnly, c);
    expect(res.covers).toBe(false);
    expect(res.checks.targets_agent).toBe('false');
  });

  test('S07: honest multi-edit work stays a candidate; the expected red is not a failure', () => {
    const x = expects('S07');
    const seq = eps('S07').find((e): e is EditSequenceEpisode => e.type === 'edit-sequence')!;
    expect(seq.edits.length).toBeGreaterThanOrEqual(x.same_file_edit_count.gte);
    expect(seq.promoted).toBe(x.promoted);
    expect(roomOf(seq)).toBeUndefined();
    expect(x.candidate_only).toBe(true);
    expect(allCalls(byLabel.get('S07')!).filter((c) => c.result?.negative === 'expected-red').length).toBe(x.expected_failure_count);
    expect(eps('S07').filter((e) => e.type === 'repeated-command').length).toBe(x.episode_type_2_count);
    expect(seq.approvedAfter).toBe(true);
    expect(byLabel.get('S07')!.turns.some((t) => t.role === 'human' && t.text === x.human_approval)).toBe(true);
  });

  test('S08: the workflow with an observable passing check; the report rule is a sharpen candidate', () => {
    const x = expects('S08');
    const w = eps('S08').find((e): e is WorkflowEpisode => e.type === 'workflow')!;
    expect(w.diffs).toEqual(['git diff --stat', 'git diff']);
    expect(w.passEvidence).toContain('passed');
    expect(x.observable_passing_check).toBe(true);
    const sharp = sharpenSuggestions(newDeck(CLAUDE_MD, AGENTS_MD), A.rooms.some((r) => r.family === 'workflow'));
    expect(sharp.map((s) => s.from)).toContain(x.sharpen_candidate_for);
  });

  test('S09: second distinct session verifies the workflow; the Workshop offers the verify-change Skill for both agents', () => {
    const x = expects('S09');
    const w = eps('S09').find((e): e is WorkflowEpisode => e.type === 'workflow')!;
    const r = roomOf(w)!;
    expect(r.kind).toBe('workshop');
    expect(r.sessions).toBe(x.workflow_session_count);
    const skill = draftCards(r).find((c) => c.type === 'skill')!;
    expect(skill.skillSlug).toBe(x.skill);
    expect(skill.targets).toBe('both');
    expect(A.route.nodes.find((n) => n.kind === 'workshop')!.rooms).toEqual([r.key]);
  });

  test('S10: a project-scoped boundary: covers P1, never P2; the line names the frozen and the new directory', () => {
    const x = expects('S10');
    const e = eps('S10').find((e): e is InterruptEpisode => e.type === 'interrupt')!;
    const r = roomOf(e)!;
    expect(r.family).toBe('boundary');
    expect(r.object.label).toBe(x.frozen_directory);
    expect(r.proposedConstraint).toContain(x.frozen_directory);
    expect(r.proposedConstraint).toContain(x.new_directory);
    const a = draftCards(r)[0]!;
    expect(a.scope).toMatchObject({ kind: 'project', projectKey: projectKey(x.project_scope) });
    const c = issue(caseFor(e, r));
    const card = take(a, [c]);
    expect(coversIn(deckWith([card]), card, c).covers).toBe(true);
    const p2: Case = { ...c, id: 'p2-twin', projectKey: projectKey(x.does_not_cover_project) };
    const res = coversIn(deckWith([acceptMapping(card, p2.id)]), acceptMapping(card, p2.id), p2);
    expect(res.covers).toBe(false);
    expect(res.checks.scope_matches).toBe('false');
  });

  test('S11: withheld for the boss; covered by the shared and a Claude-only card, not by a P2-scoped one', () => {
    const x = expects('S11');
    const r = directiveRoom();
    const e = r.withheld.find((y) => labelOf.get(y.sessionId) === 'S11')!;
    expect(!!e).toBe(x.withheld_from_room);
    expect(r.episodes.includes(e)).toBe(false);
    expect(A.route.nodes.find((n) => n.kind === 'boss')!.rooms).toContain(r.key);
    const c = issue(caseFor(e, r));
    const base = draftCards(r)[0]!;
    const shared = take(base, [c]);
    expect(coversIn(deckWith([shared]), shared, c).covers).toBe(x.covered_by_shared_card);
    const claudeOnly = take(updateCard(base, { targets: 'claude' }), [c]);
    expect(coversIn(deckWith([claudeOnly]), claudeOnly, c).covers).toBe(x.covered_by_claude_only_card);
    const p2 = take(updateCard(base, { scope: { kind: 'project', projectKey: projectKey('P2'), label: 'datalad' } }), [c]);
    expect(coversIn(deckWith([p2]), p2, c).covers).toBe(x.covered_by_P2_scoped_card);
  });
});

describe('manifest: S12', () => {
  test('S12: a later Codex case of the S01 directive, withheld; a global card for both agents covers it, a Claude-only card does not', () => {
    const x = expects('S12');
    const r = directiveRoom();
    const e = r.withheld.find((y) => labelOf.get(y.sessionId) === 'S12')!;
    expect(!!e).toBe(x.withheld_from_room);
    expect(e.type).toBe('interrupt');
    expect(e.receipt.quote).toBe(x.receipt);
    expect(e.agent).not.toBe(byLabel.get(x.distinct_case_of)!.agent);
    expect(r.projectKey).toBeNull(); // the room is not project-bound
    const base = draftCards(r)[0]!;
    expect(base.scope.kind).toBe(x.card_scope);
    expect([...x.card_targets].sort()).toEqual(['claude', 'codex']);
    const c = issue(caseFor(e, r));
    const shared = take(base, [c]);
    expect(coversIn(deckWith([shared]), shared, c).covers).toBe(x.covered_by_shared_card);
    const claudeOnly = take(updateCard(base, { targets: 'claude' }), [c]);
    const res = coversIn(deckWith([claudeOnly]), claudeOnly, c);
    expect(res.covers).toBe(x.covered_by_claude_only_card);
    expect(res.checks.targets_agent).toBe('false');
    expect(A.route.nodes.find((n) => n.kind === 'boss')!.rooms).toContain(r.key);
  });
});

describe('manifest: deck assertions (campfire, Apply, Undo)', () => {
  test('the three uv lines stack; the fused card keeps the negation, is shared by both agents, and the Claude file gets lighter', () => {
    const d = newDeck(CLAUDE_MD, AGENTS_MD);
    const uv = fuseSuggestions(d).find((s) => presentCards(d).filter((c) => s.members.includes(c.id)).every((c) => /\buv\b/.test(c.text)))!;
    expect(uv.members.length).toBe(3);
    expect(uv.autoText).toBe('Use uv, not pip.');
    const p = previewFuse(d, uv, uv.autoText!, []);
    expect(manifest.deck_assertions.fuse_uv_lines).toBe(true);
    expect(p.after!.targets).toBe('both');
    expect((manifest.deck_assertions.fused_uv_targets as string[]).sort()).toEqual(['claude', 'codex']);
    expect(p.weight.claude.after).toBeLessThan(p.weight.claude.before);
    expect(p.weight.codex.after).toBeLessThanOrEqual(p.weight.codex.before);
    // Once merged, the same words in each file are one shared card: no further suggestion for them.
    const next = applyFuse(d, uv, uv.autoText!);
    expect(fuseSuggestions(next).some((s) => presentCards(next).filter((c) => s.members.includes(c.id)).every((c) => /\buv\b/.test(c.text)))).toBe(false);
  });

  test('the two force-push lines fuse and the exception survives as visible text', () => {
    const d = newDeck(CLAUDE_MD, AGENTS_MD);
    const fp = fuseSuggestions(d).find((s) => presentCards(d).filter((c) => s.members.includes(c.id)).every((c) => /force-push/.test(c.text)))!;
    expect(fp.kind).toBe('subsumed');
    expect(fp.autoText).toContain(manifest.deck_assertions.force_push_exception_survives as string);
    const next = applyFuse(d, fp, fp.autoText!);
    expect(utf8(renderLanes(next).claude.next)).toContain(manifest.deck_assertions.force_push_exception_survives as string);
    expect(utf8(renderLanes(next).claude.next)).not.toContain('Never force-push.\n');
  });

  test('the full-suite vs focused-file red link resolves by separating conditions; the cost in coverage is shown', () => {
    const r = directiveRoom();
    const cases = [...r.episodes, ...r.withheld].map((e) => issue(caseFor(e, r)));
    const a = take(draftCards(r)[0]!, cases);
    const d = deckWith([a]);
    const red = conflicts(d);
    expect(red.length).toBe(1);
    const sep = resolveConflict(d, red[0]!, { kind: 'separate', bind: a.id, projectKey: projectKey('P2'), projectLabel: 'datalad' });
    expect(conflicts(sep)).toEqual([]);
    expect(utf8(renderLanes(sep).codex.next)).toContain('Run the full test suite before reporting done, except in datalad.');
    // Separating to P2 leaves the P1 cases (S01, S06, S11) open: the sample's narrative and its evidence disagree.
    const bound = presentCards(sep).find((c) => c.id === a.id)!;
    expect(bound.scope).toMatchObject({ kind: 'project', label: 'datalad' });
  });

  test('Apply writes only to the sample folder, Skill bodies before globals; protected notes stay byte-for-byte; Undo restores exact bytes', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'deck-sample-'));
    try {
      await cp(join(ROOT, 'home'), join(tmp, 'home'), { recursive: true });
      const roots = [
        await nodeRoot('claude', join(tmp, 'home/.claude')),
        await nodeRoot('codex', join(tmp, 'home/.codex')),
        await nodeRoot('claude-skills', join(tmp, 'home/.claude/skills')),
        await nodeRoot('codex-skills', join(tmp, 'home/.agents/skills')),
        await nodeRoot('backup', join(tmp, 'home/.claude')),
      ];
      const dir = directiveRoom();
      const shop = A.rooms.find((r) => r.family === 'workflow')!;
      const dcases = [...dir.episodes].map((e) => issue(caseFor(e, dir)));
      let d = deckWith([take(draftCards(dir)[1]!, dcases), take(draftCards(shop).find((c) => c.type === 'skill')!, [])]);
      const uv = fuseSuggestions(d).find((s) => s.members.length === 3)!;
      d = applyFuse(d, uv, uv.autoText!);
      const before = weigh(CLAUDE_MD).total;
      const read = async (root: string, rel: string) => (root === 'codex-legacy-skills' ? null : roots.find((r) => r.id === root)!.read(rel));
      const t = await applyTargets(d, A.rooms, { claude: true, codex: true }, read);
      expect(t.problems).toEqual([]);
      const plan = await makePlan(roots, t.targets);
      expect(plan.files.map((f) => f.kind)).toEqual(['guard', 'skill', 'skill', 'global', 'global']);
      const res = await applyPlan(plan, roots, plan.digest);
      expect(res.status).toBe('written');
      const claude = await readFile(join(tmp, 'home/.claude/CLAUDE.md'));
      expect(claude.toString()).toContain(manifest.deck_assertions.protected_notes as string);
      expect(claude.toString()).toContain('use the `verify-change` skill');
      expect((await readFile(join(tmp, 'home/.agents/skills/verify-change/SKILL.md'))).toString()).toStartWith('---\nname: verify-change\n');
      expect(weigh(new Uint8Array(claude)).total).toBeGreaterThan(0);
      void before;
      // The public sample itself is untouched.
      expect(sameBytes(new Uint8Array(readFileSync(join(ROOT, 'home/.claude/CLAUDE.md'))), new Uint8Array(CLAUDE_MD))).toBe(true);
      if (res.status !== 'written') return;
      const u = await undoBundle(res.receipt.bundleId, roots);
      expect(u.status).toBe('done');
      expect(sameBytes(new Uint8Array(await readFile(join(tmp, 'home/.claude/CLAUDE.md'))), new Uint8Array(CLAUDE_MD))).toBe(true);
      expect(sameBytes(new Uint8Array(await readFile(join(tmp, 'home/.codex/AGENTS.md'))), new Uint8Array(AGENTS_MD))).toBe(true);
      // Undo removed the Skill file it created but never the folder.
      expect(await readdir(join(tmp, 'home/.agents/skills/verify-change'))).toEqual([]);
      expect(manifest.deck_assertions.undo_restores_exact_bytes).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('manifest: tutorial assertions (the mirror)', () => {
  test('the character card names the sampled build with the activity line under it', () => {
    const t = manifest.tutorial_assertions;
    expect(A.mirror.character!.name as string).toBe(t.character);
    expect(A.mirror.character!.line).toBe(t.display);
    expect(A.mirror.interventions.total).toBe(t.expected_all_interventions);
    expect(A.mirror.interventions.lines).toBe(t.expected_boundary_interventions);
  });
});
