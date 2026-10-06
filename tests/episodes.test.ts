import { describe, expect, test } from 'bun:test';
import { detectEpisodes, directiveCandidates, editSequenceEpisodes, interruptEpisodes, repeatedCommandEpisodes, workflowEpisodes } from '../src/episodes';
import { parseLines } from '../src/parse/index';
import { buildRooms, caseFor } from '../src/rooms';
import { analyse } from '../src/pipeline';
import { CC, CX, fixture, sliceFixtures } from './helpers';

describe('type 1: interrupt → next genuine human message', () => {
  test('Claude directive: the quote is the human words, the action is the rejected write', async () => {
    const [e] = interruptEpisodes(await fixture(CC.directive));
    expect(e!.receipt.quote).toBe("no, don't touch anything under vendor/ — those files are generated. Only edit src/.");
    expect(e!.receipt.action).toBe('Write: tzdata/zones.json');
    expect(e!.receipt.result).toStartWith('rejected');
    expect(e!.skippedInjected).toBe(0);
  });

  test('injected text after an interrupt is skipped, never quoted', async () => {
    const eps = interruptEpisodes(await fixture(CC.injected));
    expect(eps.length).toBe(1);
    expect(eps[0]!.skippedInjected).toBe(2);
    expect(eps[0]!.receipt.quote).toBe('leave the release notes to me, just finish the net sizing change');
  });

  test('Codex turn_aborted pairs with the next user message, not the developer wrapper', async () => {
    const [e] = interruptEpisodes(await fixture(CX.desktop));
    expect(e!.interrupt).toBe('turn_aborted');
    expect(e!.receipt.quote).toStartWith('no — keep the public API names');
    expect(e!.receipt.action).toBe('exec: sed -i s/get_user/fetch_user/g src/api/public.py');
    expect(e!.receipt.result).toBe('no result recorded');
  });

  test('a pivot is detected as an episode but starts unreviewed; it never counts until the player says issue', async () => {
    const s = await fixture(CC.pivot);
    const [e] = interruptEpisodes(s);
    expect(e!.receipt.quote).toStartWith('actually, how about');
    expect(e!.pivotHint).toBe(true);
    const room = buildRooms([s], [e!])[0]!;
    expect(room.kind).toBe('event');
    expect(caseFor(e!, room).disposition).toBe('unreviewed');
  });

  test('agent-authored threads produce no interrupt episodes', async () => {
    expect(interruptEpisodes(await fixture(CC.subagent))).toEqual([]);
    expect(interruptEpisodes(await fixture(CX.subagent))).toEqual([]);
  });

  test('pairing never crosses a dropped row', () => {
    const u = (text: string) => JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: text } });
    const s = parseLines('claude', 's.jsonl', [u('go'), u('[Request interrupted by user]'), '{broken', u('stop doing that')]);
    const [e] = interruptEpisodes(s);
    expect(e!.humanTurn).toBeNull();
    expect(e!.crossesGap).toBe(true);
    expect(e!.receipt.quote).toBeNull();
  });
});

describe('type 2: repeated unsuccessful command', () => {
  test('Claude: three unchanged build failures (whitespace variant included), then a fix', async () => {
    const [e, ...rest] = repeatedCommandEpisodes(await fixture(CC.repeated));
    expect(rest).toEqual([]);
    expect(e!.fingerprint).toBe('bun run build');
    expect(e!.prefix).toBe('bun run build');
    expect(e!.failures.length).toBe(3);
    expect(e!.laterSuccess).toBe(false);
    expect(e!.receipt.quote).toBeNull();
  });

  test('Codex CLI: the same pytest failing three times, one behind a cd prefix', async () => {
    const [e] = repeatedCommandEpisodes(await fixture(CX.cli));
    expect(e!.fingerprint).toBe('pytest -q tests/test_models.py');
    expect(e!.prefix).toBe('pytest');
    expect(e!.failures.length).toBe(3);
  });

  test('NEGATIVE: an honest edit loop (fail → edit → fail → edit → pass) is not a problem: a candidate only, never a room', async () => {
    const s = await fixture(CC.editLoop);
    const eps = detectEpisodes(s);
    expect(eps.filter((e) => e.type !== 'edit-sequence' && e.type !== 'directive')).toEqual([]);
    const [seq] = editSequenceEpisodes(s);
    expect(seq).toMatchObject({ file: 'src/csv.ts', promoted: false });
    expect(seq!.edits.length).toBe(4);
    expect(buildRooms([s], eps)).toEqual([]);
  });

  test('NEGATIVE: an expected failing test (red, then green) and a grep with no match score nothing', async () => {
    const eps = detectEpisodes(await fixture(CC.expected));
    expect(eps.filter((e) => e.type === 'repeated-command' || e.type === 'interrupt' || e.type === 'edit-sequence')).toEqual([]);
  });

  test('NEGATIVE: an injected summary never becomes an episode quote', async () => {
    const eps = detectEpisodes(await fixture(CC.injected));
    for (const e of eps) expect(e.receipt.quote ?? '').not.toContain('This session is being continued');
    expect(eps.filter((e) => e.type !== 'directive').every((e) => e.type === 'interrupt')).toBe(true);
  });

  test('concurrent launches are not retries', () => {
    const a = (id: string) => JSON.stringify({ type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'make test' } }] } });
    const r = (id: string) => JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Error: Exit code 2\nboom', is_error: true }] } });
    const s = parseLines('claude', 's.jsonl', [a('t1'), a('t2'), r('t1'), r('t2')]);
    expect(repeatedCommandEpisodes(s)).toEqual([]);
    const s2 = parseLines('claude', 's.jsonl', [a('t1'), r('t1'), a('t2'), r('t2')]);
    expect(repeatedCommandEpisodes(s2).length).toBe(1);
  });

  test('an install between two failures is a change, not an unchanged retry', () => {
    const a = (id: string, cmd: string) => JSON.stringify({ type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } });
    const r = (id: string, ok: boolean) => JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ok ? 'done' : 'Error: Exit code 1\nmissing', is_error: !ok }] } });
    const s = parseLines('claude', 's.jsonl', [a('t1', 'bun test'), r('t1', false), a('t2', 'bun install'), r('t2', true), a('t3', 'bun test'), r('t3', false)]);
    expect(repeatedCommandEpisodes(s)).toEqual([]);
  });
});

describe('mirror and rooms (slice fixtures)', () => {
  test('counts carry their denominators', async () => {
    const m = analyse(await sliceFixtures()).mirror;
    expect(m.sessions).toEqual({ total: 11, claude: 7, codex: 4, agentAuthored: 2, partial: 0 });
    expect(m.interrupts).toBe(5);
    expect(m.interventions.total).toBe(5);
    expect(m.repeatedCommand.episodes).toBe(3);
    expect(m.calls.withResult).toBe(m.calls.total - 1); // the exec cut off by the Codex abort
  });

  test('repeated commands group by command prefix and project identity, across agents', async () => {
    const a = analyse(await sliceFixtures());
    const rc = a.rooms.filter((r) => r.family === 'repeated-command');
    for (const r of rc) expect(new Set(r.episodes.map((e) => e.projectKey)).size).toBe(1);
    // The same failing build in the same project under both agents is one cross-agent room, first in line.
    expect(a.rooms[0]).toMatchObject({ family: 'repeated-command', sessions: 2 });
    expect(a.rooms[0]!.object.label).toBe('bun run build');
    expect([...a.rooms[0]!.agents].sort()).toEqual(['claude', 'codex']);
  });

  test('Codex code-mode: a failing build run twice unchanged, then patched and green', async () => {
    const [e, ...rest] = repeatedCommandEpisodes(await fixture(CX.build));
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ fingerprint: 'bun run build', laterSuccess: false });
    expect(e!.failures.length).toBe(2);
  });
});

describe('type 3: same-file edit sequence', () => {
  test('POSITIVE: three edits, the fourth cut off by the person → promoted, with the person\'s words as the receipt', async () => {
    const s = await fixture(CC.rewrite);
    const [e, ...rest] = editSequenceEpisodes(s);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ file: 'src/parse/mesh.ts', promoted: true });
    expect(e!.edits.length).toBe(4); // the cut-off edit had no result and is not counted
    expect(e!.receipt.quote).toStartWith('stop rewriting the parser');
    const rooms = buildRooms([s], detectEpisodes(s));
    // The stop that promoted the rewrite belongs to the rewrite room; no second room for the same stop.
    expect(rooms.map((r) => r.family)).toEqual(['rewrite']);
  });

  test('Codex code-mode: a FileChange inside its exec patch counts once (dedupe by parentCallId)', async () => {
    const s = await fixture(CX.dedupe);
    const eps = editSequenceEpisodes(s);
    expect(eps.map((e) => [e.file, e.edits.length])).toEqual([['app/basket.py', 3]]);
    expect(eps[0]!.promoted).toBe(false);
  });

  test('NEGATIVE: two edits are not a sequence; a failed or rejected edit is not a reliable edit', () => {
    const a = (id: string) => JSON.stringify({ type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' } }] } });
    const r = (id: string, err = false) => JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: err ? 'String not found' : 'ok' }] } });
    expect(editSequenceEpisodes(parseLines('claude', 's.jsonl', [a('1'), r('1'), a('2'), r('2')]))).toEqual([]);
    expect(editSequenceEpisodes(parseLines('claude', 's.jsonl', [a('1'), r('1'), a('2'), r('2', true), a('3'), r('3')]))).toEqual([]);
  });
});

describe('type 4: repeated genuine directive', () => {
  test('POSITIVE: near-duplicate wording in two sessions and two agents forms one directive room', async () => {
    const sessions = await Promise.all([fixture(CC.directiveA), fixture(CX.directiveB)]);
    const rooms = buildRooms(sessions, sessions.flatMap(detectEpisodes));
    const d = rooms.filter((r) => r.family === 'directive');
    expect(d.length).toBe(1);
    expect(d[0]!.object.kind).toBe('text');
    expect(d[0]!.sessions).toBe(2);
    expect([...d[0]!.agents].sort()).toEqual(['claude', 'codex']);
  });

  test('NEGATIVES: the same words inside an injected summary never count; repeating yourself inside one session is not repeated across sessions', async () => {
    const s = await fixture(CC.directiveA);
    const c = directiveCandidates(s);
    expect(c.some((e) => e.text.startsWith('This session'))).toBe(false);
    expect(c.filter((e) => e.text.startsWith('keep the changelog')).length).toBe(2);
    const rooms = buildRooms([s], detectEpisodes(s));
    expect(rooms.filter((r) => r.family === 'directive')).toEqual([]);
  });
});

describe('type 5: the narrow workflow', () => {
  test('POSITIVE: focused passing test → diff review → report, in a Claude and a Codex session → one verified workshop', async () => {
    const sessions = await Promise.all([fixture(CC.workflowA), fixture(CX.workflowB)]);
    for (const s of sessions) expect(workflowEpisodes(s).length).toBe(1);
    const [w] = workflowEpisodes(sessions[1]!);
    expect(w).toMatchObject({ test: 'pytest tests/test_basket.py -q', testProgram: 'pytest', diffs: ['git diff'] });
    const rooms = buildRooms(sessions, sessions.flatMap(detectEpisodes));
    const shop = rooms.find((r) => r.family === 'workflow')!;
    expect(shop.kind).toBe('workshop');
    expect(shop.sessions).toBe(2);
  });

  test('NEGATIVES: a whole-suite run, a failing focused test, a report before the diff; one session alone is not verified', async () => {
    const neg = await fixture(CC.workflowNeg);
    expect(workflowEpisodes(neg)).toEqual([]);
    const one = await fixture(CC.workflowA);
    expect(buildRooms([one], detectEpisodes(one)).filter((r) => r.family === 'workflow')).toEqual([]);
  });
});
