import { describe, expect, test } from 'bun:test';
import { detectEpisodes, interruptEpisodes, mirror, repeatedCommandEpisodes } from '../src/episodes';
import { parseLines } from '../src/parse/index';
import { caseFor, groupRooms } from '../src/deck/templates';
import { CC, CX, fixture } from './helpers';

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
    const [e] = interruptEpisodes(await fixture(CC.pivot));
    expect(e!.receipt.quote).toStartWith('actually, how about');
    expect(caseFor(e!).disposition).toBe('unreviewed');
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

  test('NEGATIVE: an honest edit loop (fail → edit → fail → edit → pass) is not a problem', async () => {
    expect(detectEpisodes(await fixture(CC.editLoop))).toEqual([]);
  });

  test('NEGATIVE: an expected failing test (red, then green) and a grep with no match score nothing', async () => {
    expect(detectEpisodes(await fixture(CC.expected))).toEqual([]);
  });

  test('NEGATIVE: an injected summary never becomes an episode quote', async () => {
    const eps = detectEpisodes(await fixture(CC.injected));
    for (const e of eps) expect(e.receipt.quote ?? '').not.toContain('This session is being continued');
    expect(eps.every((e) => e.type === 'interrupt')).toBe(true);
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

describe('mirror and rooms', () => {
  test('counts carry their denominators', async () => {
    const all = await Promise.all([...Object.values(CC), ...Object.values(CX)].map(fixture));
    const m = mirror(all);
    expect(m.sessions).toEqual({ total: 11, claude: 7, codex: 4, agentAuthored: 2, partial: 0 });
    expect(m.interrupts).toBe(5);
    expect(m.interruptPairs).toBe(5);
    expect(m.repeatedCommand.episodes).toBe(3);
    expect(m.calls.withResult).toBe(m.calls.total - 1); // the exec cut off by the Codex abort
  });

  test('rooms group by family, object and project identity', async () => {
    const all = await Promise.all([...Object.values(CC), ...Object.values(CX)].map(fixture));
    const rooms = groupRooms(all.flatMap(detectEpisodes));
    expect(rooms.length).toBe(7);
    for (const r of rooms) expect(new Set(r.episodes.map((e) => e.projectKey)).size).toBe(1);
    // The same failing build in the same project under both agents is one cross-agent room, first in line.
    expect(rooms[0]).toMatchObject({ family: 'repeated-command', object: 'bun run build', sessions: 2 });
    expect(rooms[0]!.agents.sort()).toEqual(['claude', 'codex']);
  });

  test('Codex code-mode: a failing build run twice unchanged, then patched and green', async () => {
    const [e, ...rest] = repeatedCommandEpisodes(await fixture(CX.build));
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ fingerprint: 'bun run build', laterSuccess: false });
    expect(e!.failures.length).toBe(2);
  });
});
