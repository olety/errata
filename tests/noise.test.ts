// The noise filter: named negatives look like failures and are not. Unknown is never failure.
import { describe, expect, test } from 'bun:test';
import { allCalls } from '../src/model';
import { repeatedCommandEpisodes } from '../src/episodes';
import { exitProgramOf } from '../src/parse/common';
import { isFocusedTest, isGenuineFailure, isTestCommand, isTestPath, observablePass } from '../src/noise';
import { parseLines } from '../src/parse/index';
import { CC, CX, fixture } from './helpers';

describe('named negatives (fixtures)', () => {
  test('Claude: a harness-rejected call, a permission denial, a worktree refusal and a pipeline grep with no match', async () => {
    const s = await fixture(CC.noise);
    const byCmd = (p: string) => allCalls(s).filter((c) => c.command?.includes(p));
    expect(byCmd('git push').map((c) => c.result!.negative)).toEqual(['harness-rejected', 'harness-rejected']);
    expect(byCmd('rm -rf').map((c) => c.result!.negative)).toEqual(['permission-denied', 'permission-denied']);
    expect(byCmd('git status').map((c) => c.result!.negative)).toEqual(['worktree-refusal', 'worktree-refusal']);
    expect(byCmd('grep').map((c) => [c.result!.status, c.result!.negative])).toEqual([
      ['nomatch', 'no-match'],
      ['nomatch', 'no-match'],
    ]);
    // Each happened twice with nothing changed in between; none of them is an unsuccessful command.
    expect(allCalls(s).some(isGenuineFailure)).toBe(false);
    expect(repeatedCommandEpisodes(s)).toEqual([]);
  });

  test("Claude Code's tool-error wrapper and a hook error are refusals; a log that mentions a rejection is still a real failure", async () => {
    const s = await fixture(CC.noiseHarness);
    const by = (p: string) => allCalls(s).filter((c) => c.command?.includes(p)).map((c) => c.result!.negative ?? 'genuine');
    expect(by('npm run deploy')).toEqual(['permission-denied', 'permission-denied']);
    expect(by('make release')).toEqual(['permission-denied', 'permission-denied']);
    expect(by('check.sh')).toEqual(['genuine', 'genuine']);
    const [e, ...rest] = repeatedCommandEpisodes(s);
    expect(rest).toEqual([]);
    expect(e!.fingerprint).toBe('./scripts/check.sh');
  });

  test('Codex: a declined exec and a sandbox network denial are not failures', async () => {
    const s = await fixture(CX.noise);
    expect(allCalls(s).map((c) => c.result!.negative)).toEqual(['harness-rejected', 'harness-rejected', 'permission-denied', 'permission-denied']);
    expect(repeatedCommandEpisodes(s)).toEqual([]);
  });

  test('an expected failing test (red before green) is a named negative, and only the first red counts as expected', async () => {
    const s = await fixture(CC.expected);
    const t = allCalls(s).filter((c) => c.command?.startsWith('bun test'));
    expect(t.map((c) => [c.result!.status, c.result!.negative ?? null])).toEqual([
      ['error', 'expected-red'],
      ['ok', null],
    ]);
  });

  test('a failing test after an implementation edit is not expected red (the honest edit loop keeps its genuine failures)', async () => {
    const s = await fixture(CC.editLoop);
    const fails = allCalls(s).filter(isGenuineFailure);
    expect(fails.length).toBe(2);
    expect(repeatedCommandEpisodes(s)).toEqual([]);
  });

  test('the known slice false positive: a git status blocked by worktree isolation is no longer a repeated failure', () => {
    const a = (id: string) => JSON.stringify({ type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'cd /x/y && git status --short | head -30 && git diff --stat | tail -3' } }] } });
    const r = (id: string) => JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'This session is isolated in the worktree /x/wt, but this command targets /x/y.' }] } });
    const s = parseLines('claude', 's.jsonl', [a('t1'), r('t1'), a('t2'), r('t2')]);
    expect(repeatedCommandEpisodes(s)).toEqual([]);
  });

  test('unknown is not true: a Codex output with no exit code and no pass pattern stays unknown, never a failure', () => {
    const rows = [
      { type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: JSON.stringify({ cmd: 'make check' }), call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'error: something odd happened' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: JSON.stringify({ cmd: 'make check' }), call_id: 'c2' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'error: something odd happened' } },
    ].map((r) => JSON.stringify({ timestamp: 't', ...r }));
    const s = parseLines('codex', 'x.jsonl', rows);
    expect(allCalls(s).map((c) => c.result!.status)).toEqual(['unknown', 'unknown']);
    expect(repeatedCommandEpisodes(s)).toEqual([]);
  });
});

describe('helpers', () => {
  test('the exit status comes from the last pipeline stage', () => {
    expect(exitProgramOf('cat x | grep y')).toBe('grep');
    expect(exitProgramOf('grep y x | head -5')).toBe('head');
    expect(exitProgramOf('cd a && FOO=1 rg -n z')).toBe('rg');
    expect(exitProgramOf('a || b')).toBe('b');
  });

  test('test commands, focused runs and test paths', () => {
    expect(isTestCommand('pytest')).toBe(true);
    expect(isTestCommand('cd /x && uv run pytest -q')).toBe(true);
    expect(isTestCommand('bun run test')).toBe(true);
    expect(isTestCommand('git status')).toBe(false);
    expect(isFocusedTest('pytest pyramid/tests/test_httpexceptions.py -q')).toBe(true);
    expect(isFocusedTest('pytest -k test_ctor')).toBe(true);
    expect(isFocusedTest('pytest')).toBe(false);
    expect(isFocusedTest('bun test')).toBe(false);
    expect(isTestPath('tests/slug.test.ts')).toBe(true);
    expect(isTestPath('pkg/test_models.py')).toBe(true);
    expect(isTestPath('src/slug.ts')).toBe(false);
  });

  test('observable passes need a pass count and no failure marker', () => {
    expect(observablePass('50 passed in 4.12s')).toBe(true);
    expect(observablePass('6 pass\n0 fail')).toBe(true);
    expect(observablePass('1 failed, 3 passed')).toBe(false);
    expect(observablePass('Traceback (most recent call last):\n 3 passed')).toBe(false);
    expect(observablePass('done')).toBe(false);
  });
});

test('expected red needs a pass of the same test command; another test passing does not close it', () => {
  const a = (id: string, name: string, input: object) => JSON.stringify({ type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const r = (id: string, err: boolean, text: string) => JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: err ? `Error: Exit code 1\n${text}` : text }] } });
  const rows = [
    JSON.stringify({ type: 'user', sessionId: 's', cwd: '/w', message: { role: 'user', content: 'fix the api' } }),
    a('e1', 'Edit', { file_path: '/w/tests/test_api.py', old_string: 'a', new_string: 'b' }),
    r('e1', false, 'ok'),
    a('t1', 'Bash', { command: 'pytest tests/test_api.py' }),
    r('t1', true, '1 failed'),
    a('t2', 'Bash', { command: 'pytest tests/test_api.py' }),
    r('t2', true, '1 failed'),
    a('e2', 'Edit', { file_path: '/w/src/api.py', old_string: 'a', new_string: 'b' }),
    r('e2', false, 'ok'),
    a('t3', 'Bash', { command: 'pytest tests/test_ui.py' }),
    r('t3', false, '3 passed'),
  ];
  const s = parseLines('claude', 's.jsonl', rows);
  expect(allCalls(s).filter((c) => c.result?.negative === 'expected-red')).toEqual([]);
  expect(repeatedCommandEpisodes(s).length).toBe(1);
});
