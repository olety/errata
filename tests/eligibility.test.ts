// Per-case eligible responses from observed facts (play-loop §14.1) and the withheld cases kept out of everything the
// player sees before the boss (§0a.12, §14.7).
import { describe, expect, test } from 'bun:test';
import type { Session } from '../src/model';
import { parseLines } from '../src/parse/index';
import { detectEpisodes } from '../src/episodes';
import { buildRooms, caseFor, eligibleKeys, ineligibility } from '../src/rooms';
import { draftCards } from '../src/deck/templates';
import { sampleAnalysis, sampleManifest } from './helpers';

type Row = Record<string, unknown>;
function claude(n: number, rows: (row: (o: object) => string, ts: (m: number) => string) => string[]): Session {
  const sid = `${String(n).padStart(8, '0')}-0000-4000-8000-0000000000aa`;
  const ts = (m: number) => `2026-10-0${n}T10:${String(m).padStart(2, '0')}:00.000Z`;
  const row = (o: object) => JSON.stringify({ sessionId: sid, cwd: '/home/dev/web', ...(o as Row) });
  return parseLines('claude', `${sid}.jsonl`, rows(row, ts));
}
const user = (row: (o: object) => string, ts: string, content: unknown) => row({ type: 'user', timestamp: ts, message: { role: 'user', content } });
const bash = (row: (o: object) => string, ts: string, id: string, command: string) => row({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const edit = (row: (o: object) => string, ts: string, id: string, file: string) => row({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] } });
const result = (row: (o: object) => string, ts: string, id: string, content: string, isError = false) => row({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const INTERRUPT = [{ type: 'text', text: '[Request interrupted by user]' }];

describe('per-case eligibility from observed facts', () => {
  test('reread and carry-over need a context summary or handoff earlier in the session', () => {
    const plain = claude(1, (row, ts) => [user(row, ts(0), 'fix the date test'), bash(row, ts(1), 'a1', 'pytest'), user(row, ts(2), INTERRUPT), user(row, ts(3), "don't run the whole suite, only the test file")]);
    const summarised = claude(2, (row, ts) => [
      user(row, ts(0), 'This session is being continued from a previous conversation that ran out of context.'),
      user(row, ts(1), 'fix the date test'),
      bash(row, ts(2), 'a1', 'pytest'),
      user(row, ts(3), INTERRUPT),
      user(row, ts(4), "don't run the whole suite, only the test file"),
    ]);
    const ep = (s: Session) => detectEpisodes(s).find((e) => e.type === 'interrupt')!;
    expect(ep(plain).observed!.summaryBefore).toBe(false);
    expect(ep(summarised).observed!.summaryBefore).toBe(true);
    expect(eligibleKeys('directive', ep(plain).observed)).toEqual(['standing_instruction']);
    expect(eligibleKeys('directive', ep(summarised).observed)).toEqual(['standing_instruction', 'reread_on_resume', 'record_at_handoff']);
    expect(ineligibility('reread_on_resume', ep(plain).observed)).toBe('no context summary or handoff earlier in this session');
  });

  test('stop after two needs three attempts; read the error needs captured error output', () => {
    const two = claude(3, (row, ts) => [user(row, ts(0), 'run the build'), bash(row, ts(1), 'b1', 'make build'), result(row, ts(2), 'b1', 'error: missing header foo.h', true), bash(row, ts(3), 'b2', 'make build'), result(row, ts(4), 'b2', 'error: missing header foo.h', true)]);
    const three = claude(4, (row, ts) => [
      user(row, ts(0), 'run the build'),
      bash(row, ts(1), 'b1', 'make build'),
      result(row, ts(2), 'b1', '', true),
      bash(row, ts(3), 'b2', 'make build'),
      result(row, ts(4), 'b2', 'error: missing header foo.h', true),
      bash(row, ts(5), 'b3', 'make build'),
      result(row, ts(6), 'b3', 'error: missing header foo.h', true),
    ]);
    const rc = (s: Session) => detectEpisodes(s).find((e) => e.type === 'repeated-command')!;
    expect(rc(two).observed).toMatchObject({ attempts: 2, errorCaptured: true });
    expect(rc(three).observed).toMatchObject({ attempts: 3, errorCaptured: false });
    expect(eligibleKeys('repeated-command', rc(two).observed)).toEqual(['inspect_error_before_retry', 'state_hypothesis_before_retry']);
    expect(eligibleKeys('repeated-command', rc(three).observed)).toEqual(['state_hypothesis_before_retry', 'report_blocker_after_two']);
  });

  test('check the diff needs an edit that landed after the stop', () => {
    const noEdit = claude(5, (row, ts) => [user(row, ts(0), 'tidy the config'), edit(row, ts(1), 'e1', '/home/dev/web/src/a.ts'), user(row, ts(2), INTERRUPT), user(row, ts(3), 'stop, leave src/a.ts alone')]);
    const withEdit = claude(6, (row, ts) => [
      user(row, ts(0), 'tidy the config'),
      edit(row, ts(1), 'e1', '/home/dev/web/src/a.ts'),
      user(row, ts(2), INTERRUPT),
      user(row, ts(3), 'stop, leave src/a.ts alone'),
      edit(row, ts(4), 'e2', '/home/dev/web/src/b.ts'),
      result(row, ts(5), 'e2', 'ok'),
    ]);
    const ie = (s: Session) => detectEpisodes(s).find((e) => e.type === 'interrupt')!;
    expect(ie(noEdit).observed!.editAfterStop).toBe(false);
    expect(ie(withEdit).observed!.editAfterStop).toBe(true);
    expect(eligibleKeys('boundary', ie(noEdit).observed)).toEqual(['preserve_boundary', 'confirm_scope_before_edit']);
    expect(eligibleKeys('boundary', ie(withEdit).observed)).toEqual(['preserve_boundary', 'confirm_scope_before_edit', 'inspect_diff_against_boundary']);
  });

  test('a case built from an episode without observed facts gets only the always-eligible responses', () => {
    expect(eligibleKeys('rewrite', undefined)).toEqual(['targeted_patch', 'reproduce_first', 'summarise_hypotheses']);
    expect(eligibleKeys('workflow', undefined)).toEqual(['verification_gate', 'result_summary', 'mint_skill']);
    expect(eligibleKeys('directive', undefined)).toEqual(['standing_instruction']);
  });

  test('on the sample, the directive room deals one eligible response per case, not three', async () => {
    const A = await sampleAnalysis();
    const r = A.rooms.find((x) => x.family === 'directive' && x.withheld.length > 0)!;
    for (const e of r.episodes) expect(caseFor(e, r).eligibleResponseKeys).toEqual(['standing_instruction']);
  });
});

const manifest = sampleManifest();

describe('withheld cases stay out until the boss (§14.7)', () => {
  test('S12 and S11 never appear in a room, a receipt, an example, a draft or a draft text before the boss', async () => {
    const A = await sampleAnalysis();
    const idOf = (label: string) => [...A.labels.entries()].find(([, l]) => l === label)![0];
    const held = new Set(['S11', 'S12'].map(idOf));
    const r = A.rooms.find((x) => x.withheld.some((e) => held.has(e.sessionId)))!;
    expect(r.withheld.map((e) => A.labels.get(e.sessionId)).sort()).toEqual(['S11', 'S12']);
    const s12 = manifest.expected_outcomes.find((x) => x.session === 'S12')!.expects.receipt as string;
    for (const room of A.rooms) {
      expect(room.episodes.some((e) => held.has(e.sessionId))).toBe(false);
      expect(held.has(room.anchor.sessionId)).toBe(false);
      for (const card of draftCards(room)) {
        expect(card.evidenceRefs.some((ref) => held.has(ref.sessionId))).toBe(false);
        expect(card.text).not.toContain(s12);
      }
      if (room.proposedConstraint) expect(room.proposedConstraint).not.toContain(s12);
    }
    // The room's agents, projects and support count come from in-room cases only.
    const inRoomAgents = [...new Set(r.episodes.map((e) => e.agent))].sort();
    expect([...r.agents].sort()).toEqual(inRoomAgents);
    expect(r.sessions).toBe(new Set(r.episodes.map((e) => e.sessionId)).size);
  });

  test('a withheld case in another project does not widen the room, and a withheld agent does not widen its drafts', () => {
    // Four sessions: three Claude in web, then one Codex-free Claude in api held back for the boss.
    const mk = (n: number, cwd: string) => {
      const sid = `${String(n).padStart(8, '0')}-0000-4000-8000-0000000000bb`;
      const ts = (m: number) => `2026-10-0${n}T10:0${m}:00.000Z`;
      const row = (o: object) => JSON.stringify({ sessionId: sid, cwd, ...(o as Row) });
      return parseLines('claude', `${sid}.jsonl`, [
        user(row, ts(0), 'fix the date test'),
        bash(row, ts(1), `a${n}`, 'pytest'),
        user(row, ts(2), INTERRUPT),
        user(row, ts(3), "don't run the whole suite, just the one file"),
        bash(row, ts(4), `b${n}`, 'pytest tests/test_dates.py -q'),
        result(row, ts(5), `b${n}`, '4 passed'),
      ]);
    };
    const sessions = [mk(1, '/home/dev/web'), mk(2, '/home/dev/web'), mk(3, '/home/dev/web'), mk(4, '/home/dev/api')];
    const r = buildRooms(sessions, sessions.flatMap(detectEpisodes))[0]!;
    expect(r.withheld.length).toBe(1);
    expect(r.projects.map((p) => p.label)).toEqual(['web']);
    expect(r.projectLabel).toBe('web');
    // The drafts are scoped to web; the held-out api case then fails the scope check at the boss, honestly.
    expect(draftCards(r)[0]!.scope).toMatchObject({ kind: 'project', label: 'web' });
  });
});
