import { describe, expect, test } from 'bun:test';
import { allCalls, OVERSIZED_SESSION_BYTES, projectFromCwd } from '../src/model';
import { parseLines, parseSessionFile } from '../src/parse/index';
import { CC, CX, fixture } from './helpers';

describe('Claude Code parser', () => {
  test('keeps roles, pairs every call with its result, marks the tool-use interrupt', async () => {
    const s = await fixture(CC.directive);
    expect(s.agent).toBe('claude');
    expect(s.id).toBe('claude:a1b2c3d4-1111-4111-8111-000000000001');
    expect(s.project).toBe('tidepool');
    expect(s.gitBranch).toBe('main');
    expect(s.turns.map((t) => t.role)).toEqual(['human', 'assistant', 'interrupt', 'human', 'assistant']);
    expect(s.turns[2]!.interrupt).toBe('tool_use');
    const calls = allCalls(s);
    expect(calls.map((c) => c.name)).toEqual(['Read', 'Edit', 'Write', 'Bash']);
    expect(calls.every((c) => c.result !== null)).toBe(true);
    expect(calls[2]!.result!.status).toBe('rejected');
    expect(calls[3]!.result).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(calls[1]!.files[0]).toEndWith('src/dates.ts');
    expect(s.stats.orphanResults).toBe(0);
    expect(s.partial).toBe(false);
  });

  test('never stores thinking text', async () => {
    const s = await fixture(CC.directive);
    expect(s.turns.some((t) => t.text.includes('internal'))).toBe(false);
  });

  test('quarantines summaries, cross-session messages, tags, images and meta rows', async () => {
    const s = await fixture(CC.injected);
    const injected = s.turns.filter((t) => t.role === 'injected').map((t) => t.injected);
    expect(injected).toEqual(['summary', 'summary', 'cross-session', 'tag', 'tag', 'tag', 'image', 'image', 'meta', 'tag', 'cross-session']);
    const humans = s.turns.filter((t) => t.role === 'human').map((t) => t.text);
    expect(humans).toEqual(['leave the release notes to me, just finish the net sizing change']);
  });

  test('plain interrupt marker and a result interrupted by the user', async () => {
    const s = await fixture(CC.pivot);
    expect(s.turns.find((t) => t.role === 'interrupt')!.interrupt).toBe('user');
    expect(allCalls(s)[0]!.result!.status).toBe('interrupted');
  });

  test('a grep that finds nothing is nomatch, not an error', async () => {
    const s = await fixture(CC.repeated);
    const grep = allCalls(s).find((c) => c.command?.startsWith('grep'))!;
    expect(grep.result).toMatchObject({ status: 'nomatch', exitCode: 1 });
    const fails = allCalls(s).filter((c) => c.result?.status === 'error');
    expect(fails.map((c) => c.result!.exitCode)).toEqual([2, 2, 2]);
  });

  test('a subagent file is agent-authored: its user text is never human, its id is unique', async () => {
    const s = await fixture(CC.subagent);
    expect(s.agentAuthored).toBe(true);
    expect(s.id).toBe('claude:a1b2c3d4-7777-4777-8777-000000000007/agent-a7f00001');
    expect(s.turns.filter((t) => t.role === 'human')).toEqual([]);
    expect(s.turns[0]!.injected).toBe('agent-task');
  });
});

describe('Codex parser', () => {
  test('Desktop shape: content kinds split context from the human, code-mode commands become child calls', async () => {
    const s = await fixture(CX.desktop);
    expect(s.agent).toBe('codex');
    expect(s.id).toBe('codex:0c0d0e0f-8888-7888-8888-000000000008');
    expect(s.client).toBe('Codex Desktop');
    expect(s.source).toBe('vscode'); // Desktop logs source "vscode": originator and source stay separate
    expect(s.project).toBe('harbor');
    expect(s.turns.map((t) => t.role)).toEqual(['injected', 'injected', 'injected', 'human', 'assistant', 'interrupt', 'injected', 'human', 'assistant']);
    expect(s.turns.slice(0, 3).map((t) => t.injected)).toEqual(['developer', 'context', 'context']);
    expect(s.turns[5]!.interrupt).toBe('turn_aborted');
    const calls = allCalls(s);
    const child = calls.find((c) => c.name === 'exec_command')!;
    expect(child.parentCallId).toBe('call_x1');
    expect(child.command).toBe('rg -n get_user src');
    expect(child.result).toMatchObject({ status: 'ok', exitCode: 0 });
    const patchExec = calls.find((c) => c.callId === 'call_x2')!;
    expect(patchExec.kind).toBe('edit');
    expect(patchExec.files).toEqual(['src/api/routes.py']);
    const fc = calls.find((c) => c.name === 'file_change')!;
    expect(fc).toMatchObject({ parentCallId: 'call_x2', files: ['src/api/routes.py'] });
    // The exec cut off by the abort keeps no invented result.
    expect(calls.find((c) => c.callId === 'call_x3')!.result).toBeNull();
    expect(calls.find((c) => c.callId === 'call_x1')!.result!.status).toBe('ok');
  });

  test('CLI shape: shell apply_patch, exec_command exit codes, text-classified context', async () => {
    const s = await fixture(CX.cli);
    expect(s.gitBranch).toBe('fix/sizes');
    expect(s.client).toBe('codex_cli_rs');
    expect(s.turns.map((t) => t.role)).toEqual(['injected', 'human', 'assistant', 'interrupt', 'injected', 'human', 'assistant']);
    const calls = allCalls(s);
    expect(calls[0]).toMatchObject({ kind: 'edit', files: ['app/models.py'] });
    expect(calls[0]!.result).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(calls.slice(1).map((c) => c.result!.exitCode)).toEqual([1, 1, 1]);
    expect(calls.slice(1).every((c) => c.result!.status === 'error')).toBe(true);
  });

  test('subagent thread: inherited and agent-authored user text are never human', async () => {
    const s = await fixture(CX.subagent);
    expect(s.agentAuthored).toBe(true);
    expect(s.source).toBe('subagent');
    expect(s.turns.filter((t) => t.role === 'human')).toEqual([]);
    expect(s.turns.slice(0, 2).map((t) => t.injected)).toEqual(['inherited', 'agent-task']);
  });

  test('a user.text item that is a pasted continuation summary is still quarantined', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-01T00:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'This session is being continued from earlier.' }, { type: 'input_text', text: 'please keep going' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text', 'user.text'] } },
    });
    const s = parseLines('codex', 'x.jsonl', [line]);
    expect(s.turns.map((t) => `${t.role}:${t.injected ?? ''}`)).toEqual(['injected:summary', 'human:']);
  });

  test('app-injected wrappers inside user.text items are quarantined', () => {
    const line = JSON.stringify({
      timestamp: 't',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<in-app-browser-context>page</in-app-browser-context>' }, { type: 'input_text', text: 'fix the header' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text', 'user.text'] } },
    });
    expect(parseLines('codex', 'x.jsonl', [line]).turns.map((t) => t.role)).toEqual(['injected', 'human']);
  });

  test('turn_aborted with a reason other than interrupted is not an interrupt', () => {
    const s = parseLines('codex', 'x.jsonl', [JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: null, reason: 'replaced' } })]);
    expect(s.turns).toEqual([]);
  });

  test('a CommandExecution mirroring a direct shell call attaches, never duplicates', () => {
    const rows = [
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'make check' }), call_id: 'c1' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'ce1', command: ['/bin/bash', '-lc', 'make check'], status: 'completed', exit_code: 2, aggregated_output: 'boom' } } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 2' } },
    ].map((r) => JSON.stringify({ timestamp: 't', ...r }));
    const s = parseLines('codex', 'x.jsonl', rows);
    const calls = allCalls(s);
    expect(calls.length).toBe(1);
    expect(calls[0]!.result).toMatchObject({ status: 'error', exitCode: 2 });
  });
});

describe('robustness', () => {
  test('bad lines become gaps and a truncated last line marks the session partial', () => {
    const good = JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/home/dev/x', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'hello there' } });
    const s = parseLines('claude', 's1.jsonl', [good, '{not json', good, '{"type":"user","mess']);
    expect(s.stats.badLines).toBe(2);
    expect(s.gaps.map((g) => g.kind)).toEqual(['bad-line', 'bad-line']);
    expect(s.partial).toBe(true);
    expect(s.partialReason).toBe('truncated-line');
  });

  test('secrets in tool input and output are redacted at parse time and counted', () => {
    const fake = 'sk-proj-' + 'Zq8x'.repeat(8);
    const rows = [
      { type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${'ab12'.repeat(6)}" https://example.test` } }] } },
      { type: 'user', sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `OPENAI_API_KEY=${fake}` }] } },
      { type: 'user', sessionId: 's', message: { role: 'user', content: `use this key ${fake} please` } },
    ].map((r) => JSON.stringify(r));
    const s = parseLines('claude', 's.jsonl', rows);
    const dump = JSON.stringify(s);
    expect(dump).not.toContain(fake);
    expect(dump).not.toContain('ab12ab12ab12');
    expect(Object.values(s.stats.redactions).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3);
  });

  test('oversized sessions are read as header + tail window and marked partial', async () => {
    const head = JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: { id: 'big', cwd: '/home/dev/big', originator: 'codex_cli_rs' } });
    const filler = JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', pad: 'x'.repeat(4000) } });
    const tail = JSON.stringify({ timestamp: 't9', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'final words' }] } });
    const n = Math.ceil(OVERSIZED_SESSION_BYTES / filler.length) + 10;
    const blob = new Blob([head + '\n', (filler + '\n').repeat(n), tail + '\n']);
    const s = await parseSessionFile({ rel: 'rollout-big.jsonl', blob });
    expect(s.id).toBe('codex:big');
    expect(s.partial).toBe(true);
    expect(s.partialReason).toBe('tail-window');
    expect(s.gaps[0]!.kind).toBe('tail-window');
    expect(s.turns.at(-1)!.text).toBe('final words');
    expect(s.stats.lines).toBeLessThan(n);
  });

  test('project chips: homes and drive roots are not projects', () => {
    expect(projectFromCwd('/home/sam')).toBeNull();
    expect(projectFromCwd('C:')).toBeNull();
    expect(projectFromCwd('/home/sam/work/api')).toBe('api');
  });
});
