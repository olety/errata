// Grouping, withholding, the linear route and dispositions (spec §1, §2).
import { describe, expect, test } from 'bun:test';
import type { Session } from '../src/model';
import { parseLines } from '../src/parse/index';
import { detectEpisodes } from '../src/episodes';
import { buildRooms, buildRoute, caseFor, Dispositions, proposeConstraint, splitByProject } from '../src/rooms';
import { allFixtures } from './helpers';

/** A Claude session where the person stops a whole-suite run and asks for one file. */
function stopSession(n: number, day: number, cwd: string, words: string, cmd = 'pytest'): Session {
  const sid = `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ts = (m: number) => `2026-10-${String(day).padStart(2, '0')}T10:0${m}:00.000Z`;
  const row = (o: object) => JSON.stringify({ sessionId: sid, cwd, ...o });
  return parseLines('claude', `${sid}.jsonl`, [
    row({ type: 'user', timestamp: ts(0), message: { role: 'user', content: 'fix the failing date test' } }),
    row({ type: 'assistant', timestamp: ts(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: `a${n}`, name: 'Bash', input: { command: cmd } }] } }),
    row({ type: 'user', timestamp: ts(2), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    row({ type: 'user', timestamp: ts(3), message: { role: 'user', content: words } }),
    row({ type: 'assistant', timestamp: ts(4), message: { role: 'assistant', content: [{ type: 'tool_use', id: `b${n}`, name: 'Bash', input: { command: 'pytest tests/test_dates.py -q' } }] } }),
    row({ type: 'user', timestamp: ts(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `b${n}`, content: '4 passed' }] } }),
  ]);
}

const WORDS = ["don't run the whole suite, just the one file", 'only the test file please', 'one file, not everything', 'not the whole suite again', 'just the file I named', 'single file only', 'stop running everything'];

describe('rooms', () => {
  test('stops on the same command group across projects; support is distinct sessions; later cases are withheld', () => {
    const sessions = WORDS.map((w, i) => stopSession(i + 1, i + 1, i % 2 ? '/home/dev/api' : '/home/dev/web', w));
    const rooms = buildRooms(sessions, sessions.flatMap(detectEpisodes));
    const r = rooms.find((x) => x.object.key === 'cmd:pytest')!;
    expect(r.family).toBe('directive');
    expect(r.totalSessions).toBe(7);
    // Keep three sessions in the room; withhold up to three later distinct cases for the boss.
    expect(r.sessions).toBe(4);
    expect(r.withheld.length).toBe(3);
    const lastDays = r.withheld.map((e) => e.ts!.slice(8, 10));
    expect(lastDays).toEqual(['05', '06', '07']);
    expect(r.projectKey).toBeNull();
    expect(r.projects.map((p) => p.label).sort()).toEqual(['api', 'web']);
    expect(r.narrowedTests).toBe(true);
  });

  test('a single stop is a boundary room; four sessions withhold one; three withhold none', () => {
    const one = [stopSession(1, 1, '/home/dev/web', WORDS[0]!)];
    expect(buildRooms(one, one.flatMap(detectEpisodes))[0]!.family).toBe('boundary');
    const four = WORDS.slice(0, 4).map((w, i) => stopSession(i + 1, i + 1, '/home/dev/web', w));
    const r4 = buildRooms(four, four.flatMap(detectEpisodes))[0]!;
    expect([r4.sessions, r4.withheld.length]).toEqual([3, 1]);
    const three = four.slice(0, 3);
    expect(buildRooms(three, three.flatMap(detectEpisodes))[0]!.withheld).toEqual([]);
  });

  test('confirming one project splits the room; each part is rebuilt under the same rules', () => {
    const sessions = WORDS.slice(0, 5).map((w, i) => stopSession(i + 1, i + 1, i % 2 ? '/home/dev/api' : '/home/dev/web', w));
    const r = buildRooms(sessions, sessions.flatMap(detectEpisodes))[0]!;
    const web = r.projects.find((p) => p.label === 'web')!.key;
    const [mine, rest] = splitByProject(r, web);
    expect(mine!.projectLabel).toBe('web');
    expect(mine!.totalSessions).toBe(3);
    expect(rest!.projectLabel).toBe('api');
    expect(rest!.totalSessions).toBe(2);
    expect(mine!.key).not.toBe(rest!.key);
  });

  test('the proposed constraint keeps the person\'s own clauses that draw a line', () => {
    expect(proposeConstraint("stop. don't run the whole suite, it takes ten minutes here. run only the one test file I named, I'll run the rest myself")).toBe(
      "Don't run the whole suite, it takes ten minutes here. Run only the one test file I named, I'll run the rest myself.",
    );
    expect(proposeConstraint('in P1 never touch `pyramid/tests/`, it\'s frozen. do it in `pyramid/config/` instead')).toBe('In P1 never touch `pyramid/tests/`, it\'s frozen. Do it in `pyramid/config/` instead.');
  });

  test('case facts are observed: the cut-off command for a stop, the cluster key for a repeated directive', () => {
    const sessions = WORDS.slice(0, 2).map((w, i) => stopSession(i + 1, i + 1, '/home/dev/web', w));
    const r = buildRooms(sessions, sessions.flatMap(detectEpisodes))[0]!;
    const c = caseFor(r.anchor, r);
    expect(c.facts).toEqual({ event: 'resume_after_interrupt', fingerprint: 'pytest' });
    expect(c.eligibleResponseKeys).toEqual(['standing_instruction', 'reread_on_resume', 'record_at_handoff']);
    expect(c.disposition).toBe('unreviewed');
  });
});

describe('stop replies', () => {
  /** A stop during `cmd` and a reply; the agent then runs `next`. */
  function stopDuring(n: number, cmd: string, reply: string, next = 'echo done'): Session {
    const sid = `${String(n).padStart(8, '0')}-1111-4000-8000-000000000000`;
    const row = (o: object) => JSON.stringify({ sessionId: sid, cwd: '/home/dev/web', ...o });
    return parseLines('claude', `${sid}.jsonl`, [
      row({ type: 'user', timestamp: `2026-10-0${n}T10:00:00.000Z`, message: { role: 'user', content: 'go on' } }),
      row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `a${n}`, name: 'Bash', input: { command: cmd } }] } }),
      row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      row({ type: 'user', timestamp: `2026-10-0${n}T10:01:00.000Z`, message: { role: 'user', content: reply } }),
      row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `b${n}`, name: 'Bash', input: { command: next } }] } }),
      row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `b${n}`, content: 'ok' }] } }),
    ]);
  }

  test('stops during the same generic command with unrelated replies stand alone; a question forms no room', () => {
    const ss = [stopDuring(1, 'grep -rn foo src', "don't touch the generated files"), stopDuring(2, 'grep -rn bar lib', 'never push to main'), stopDuring(3, 'grep -rn baz .', 'will more workers help here?')];
    const eps = ss.flatMap(detectEpisodes);
    expect(eps.filter((e) => e.type === 'interrupt').map((e) => (e.type === 'interrupt' ? e.reply : ''))).toEqual(['line', 'line', 'other']);
    const rooms = buildRooms(ss, eps);
    expect(rooms.map((r) => [r.family, r.object.kind])).toEqual([
      ['boundary', 'none'],
      ['boundary', 'none'],
    ]);
  });

  test('a reply that names the cut-off command groups by it; so does a narrowed rerun with no line words', () => {
    const ss = [stopDuring(1, 'git push --force origin main', 'no force push, ever'), stopDuring(2, 'git push -f origin dev', 'git push without force please'), stopDuring(4, 'pytest', 'one file.', 'pytest tests/test_a.py -q')];
    const rooms = buildRooms(ss, ss.flatMap(detectEpisodes));
    const push = rooms.find((r) => r.object.key === 'cmd:git push')!;
    expect(push.family).toBe('directive');
    expect(push.sessions).toBe(2);
    const narrowed = rooms.find((r) => r.object.key === 'cmd:pytest')!;
    expect(narrowed.family).toBe('boundary');
    expect(narrowed.narrowedTests).toBe(true);
  });
});

describe('route', () => {
  test('rich evidence: eight slots in order, the elite is a recurring pattern, the boss replays withheld cases', async () => {
    const extra = [...WORDS.map((w, i) => stopSession(i + 1, i + 1, '/home/dev/web', w)), ...WORDS.slice(0, 3).map((w, i) => stopSession(20 + i, 10 + i, '/home/dev/web', 'leave the e2e run to me', 'npm run e2e'))];
    const sessions = [...(await allFixtures()), ...extra];
    const rooms = buildRooms(sessions, sessions.flatMap(detectEpisodes));
    const route = buildRoute(rooms, { importedCards: 3 });
    expect(route.nodes.map((n) => n.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(route.nodes.map((n) => n.kind)).toEqual(['encounter', 'event', 'campfire', 'elite', 'workshop', 'campfire', 'boss', 'apply']);
    const byKey = new Map(rooms.map((r) => [r.key, r]));
    expect(byKey.get(route.nodes[0]!.rooms[0]!)!.totalSessions).toBeGreaterThanOrEqual(byKey.get(route.nodes[3]!.rooms[0]!)!.totalSessions);
    expect(byKey.get(route.nodes[3]!.rooms[0]!)!.totalSessions).toBeGreaterThanOrEqual(3);
    for (const k of route.nodes[6]!.rooms) expect(byKey.get(k)!.withheld.length).toBeGreaterThan(0);
    // No room is visited twice before the boss; the boss replays rooms already visited.
    const placed = route.nodes.filter((n) => n.kind !== 'boss').flatMap((n) => n.rooms);
    for (const k of route.nodes[6]!.rooms) expect(placed).toContain(k);
    expect(new Set(placed).size).toBe(placed.length);
  });

  test('thin evidence: the act gets shorter, never padded', () => {
    const one = [stopSession(1, 1, '/home/dev/web', WORDS[0]!)];
    const route = buildRoute(buildRooms(one, one.flatMap(detectEpisodes)));
    expect(route.nodes.map((n) => n.kind)).toEqual(['encounter', 'campfire', 'audit', 'apply']);
    expect(buildRoute([]).nodes.map((n) => n.kind)).toEqual(['audit', 'apply']);
    expect(buildRoute([], { importedCards: 2 }).nodes.map((n) => n.kind)).toEqual(['card-review', 'campfire', 'audit', 'apply']);
  });
});

describe('dispositions', () => {
  test('issue / pivot / not a problem / unclear persist per episode id and round-trip as JSON', () => {
    const d = new Dispositions();
    d.set('claude:a:i3', 'issue');
    d.set('codex:b:i1', 'pivot');
    d.set('claude:c:r0', 'not-a-problem');
    d.set('claude:d:i9', 'unclear');
    d.set('claude:e:i1', 'issue');
    d.set('claude:e:i1', 'unreviewed');
    const back = Dispositions.fromJSON(JSON.parse(JSON.stringify(d)));
    expect(back.get('claude:a:i3')).toBe('issue');
    expect(back.get('codex:b:i1')).toBe('pivot');
    expect(back.get('claude:c:r0')).toBe('not-a-problem');
    expect(back.get('claude:d:i9')).toBe('unclear');
    expect(back.get('claude:e:i1')).toBe('unreviewed');
    expect(back.size).toBe(4);
    expect(Dispositions.fromJSON({ version: 2 }).size).toBe(0);
    expect(Dispositions.fromJSON({ version: 1, dispositions: { x: 'bogus' } }).size).toBe(0);
  });
});
