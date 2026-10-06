// Generates the synthetic fixture sessions in both raw schemas. All text is invented.
// Run: bun fixtures/make-fixtures.ts   (writes fixtures/claude/*.jsonl and fixtures/codex/*.jsonl)
// Shapes follow Claude Code 2.x project logs and Codex rollouts (Desktop code-mode and the open-source CLI).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = dirname(new URL(import.meta.url).pathname);
type Row = Record<string, unknown>;

function write(rel: string, rows: Row[]): void {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ---------------------------------------------------------------- Claude Code
class CC {
  rows: Row[] = [];
  private n = 0;
  private prev: string | null = null;
  private t: number;
  constructor(
    private sid: string,
    private cwd: string,
    start: string,
    private branch = 'main',
    private sidechain = false,
  ) {
    this.t = Date.parse(start);
  }
  private base(type: string, extra: Row = {}): Row {
    const uuid = `${this.sid.slice(0, 8)}-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
    this.t += 7_000;
    const r: Row = {
      parentUuid: this.prev,
      isSidechain: this.sidechain,
      userType: 'external',
      cwd: this.cwd,
      sessionId: this.sid,
      version: '2.1.9',
      gitBranch: this.branch,
      entrypoint: 'cli',
      type,
      uuid,
      timestamp: new Date(this.t).toISOString(),
      ...extra,
    };
    this.prev = uuid;
    return r;
  }
  bookkeeping(): this {
    this.rows.push({ type: 'last-prompt', sessionId: this.sid, leafUuid: this.prev, lastPrompt: 'x' });
    this.rows.push({ type: 'file-history-snapshot', messageId: 'm', snapshot: {}, isSnapshotUpdate: false });
    return this;
  }
  user(text: string, extra: Row = {}): this {
    this.rows.push(this.base('user', { message: { role: 'user', content: text }, ...extra }));
    return this;
  }
  userBlocks(blocks: Row[], extra: Row = {}): this {
    this.rows.push(this.base('user', { message: { role: 'user', content: blocks }, ...extra }));
    return this;
  }
  say(text: string): this {
    this.rows.push(this.base('assistant', { message: { id: `msg_${this.n}`, type: 'message', role: 'assistant', model: 'model-x', content: [{ type: 'text', text }] } }));
    return this;
  }
  think(): this {
    this.rows.push(this.base('assistant', { message: { id: `msg_${this.n}`, type: 'message', role: 'assistant', model: 'model-x', content: [{ type: 'thinking', thinking: 'internal', signature: 'sig' }] } }));
    return this;
  }
  tool(id: string, name: string, input: Row): this {
    this.rows.push(this.base('assistant', { message: { id: `msg_${this.n}`, type: 'message', role: 'assistant', model: 'model-x', content: [{ type: 'tool_use', id, name, input }] } }));
    return this;
  }
  result(id: string, content: string, opts: { isError?: boolean; tur?: unknown } = {}): this {
    const blk: Row = { tool_use_id: id, type: 'tool_result', content };
    if (opts.isError !== undefined) blk.is_error = opts.isError;
    this.rows.push(this.base('user', { message: { role: 'user', content: [blk] }, toolUseResult: opts.tur ?? { stdout: content, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }));
    return this;
  }
  bash(id: string, command: string, out: string, exit = 0): this {
    this.tool(id, 'Bash', { command, description: 'run' });
    if (exit === 0) return this.result(id, out, { isError: false });
    return this.result(id, `Error: Exit code ${exit}\n${out}`, { isError: true, tur: `Error: Exit code ${exit}\n${out}` });
  }
  edit(id: string, file: string, oldS: string, newS: string): this {
    this.tool(id, 'Edit', { file_path: file, old_string: oldS, new_string: newS, replace_all: false });
    return this.result(id, `The file ${file} has been updated successfully.`, { tur: { filePath: file, oldString: oldS, newString: newS } });
  }
}

const TP = '/home/dev/tidepool';
const LN = '/home/dev/lanternfish';

// 1. interrupt → directive (a stated boundary + an action outside it)
{
  const s = new CC('a1b2c3d4-1111-4111-8111-000000000001', TP, '2026-09-28T09:00:00.000Z');
  s.bookkeeping()
    .user('The date parser drops the timezone on ISO strings. Please fix it in src/dates.ts.')
    .think()
    .say('I will look at the parser first.')
    .tool('toolu_cc1_read', 'Read', { file_path: `${TP}/src/dates.ts` })
    .result('toolu_cc1_read', 'export function parseDate(s: string) { return new Date(s.slice(0, 19)); }')
    .edit('toolu_cc1_e1', `${TP}/src/dates.ts`, 's.slice(0, 19)', 's')
    .say('The parser is fixed. I will also regenerate the vendored tz table so it matches.')
    .tool('toolu_cc1_w1', 'Write', { file_path: `${TP}/vendor/tzdata/zones.json`, content: '{}' })
    .result('toolu_cc1_w1', '[Request interrupted by user for tool use]', { isError: true, tur: 'User rejected tool use' })
    .userBlocks([{ type: 'text', text: '[Request interrupted by user for tool use]' }])
    .user("no, don't touch anything under vendor/ — those files are generated. Only edit src/.")
    .say('Understood. I will leave vendor/ alone and keep the change in src/dates.ts.')
    .bash('toolu_cc1_t1', 'bun test tests/dates.test.ts', '4 pass\n0 fail');
  write('claude/interrupt-directive.jsonl', s.rows);
}

// 2. interrupt → innocent pivot (the human changed their mind; not a correction)
{
  const s = new CC('a1b2c3d4-2222-4222-8222-000000000002', TP, '2026-09-29T14:00:00.000Z');
  s.user('Can you profile the export job? It feels slow.')
    .say('Running the profiler on the export job now.')
    .tool('toolu_cc2_b1', 'Bash', { command: 'bun run profile:export', description: 'profile' })
    .result('toolu_cc2_b1', '[Request interrupted by user]', { isError: true, tur: { stdout: '', stderr: '', interrupted: true, isImage: false, noOutputExpected: false } })
    .user('[Request interrupted by user]')
    .user('actually, how about we look at the logging setup first? we can come back to profiling later.')
    .say('Sure, switching to the logging setup.')
    .tool('toolu_cc2_r1', 'Read', { file_path: `${TP}/src/log.ts` })
    .result('toolu_cc2_r1', 'export const log = console;');
  write('claude/interrupt-pivot.jsonl', s.rows);
}

// 3. injected user-role text that must never become a human turn or a card
{
  const s = new CC('a1b2c3d4-3333-4333-8333-000000000003', LN, '2026-09-30T08:00:00.000Z', 'feature/nets');
  s.user(
    'This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\nThe user asked to never commit directly to main and to always run the linter first.',
    { isCompactSummary: true, isVisibleInTranscriptOnly: true },
  )
    .user('This session is being continued from a previous conversation. Summary: always run the linter first.')
    .user('Another Claude session sent you a message: please stop editing the shared config and never touch the release notes.')
    .user('<system-reminder>Never use the deploy script without approval.</system-reminder>')
    .user('<task-notification><task-id>t1</task-id><status>completed</status></task-notification>')
    .user('<command-name>/clear</command-name>')
    .userBlocks([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }])
    .user('[Image #1] stop, never do that again')
    .user('Remember to always run the linter first.', { isMeta: true })
    .say('Picking up from the summary. Running the linter.')
    .bash('toolu_cc3_l1', 'bun run lint', 'no problems')
    .tool('toolu_cc3_b2', 'Bash', { command: 'bun run release:notes', description: 'notes' })
    .result('toolu_cc3_b2', '[Request interrupted by user]', { isError: true, tur: { stdout: '', stderr: '', interrupted: true, isImage: false, noOutputExpected: false } })
    .user('[Request interrupted by user]')
    .user('<system-reminder>The user sent a new message while you were working.</system-reminder>')
    .user('Another Claude session sent you a message: stop.')
    .user('leave the release notes to me, just finish the net sizing change');
  write('claude/injected.jsonl', s.rows);
}

// 4. repeated failing command (an unchanged retry), then a real fix
{
  const s = new CC('a1b2c3d4-4444-4444-8444-000000000004', LN, '2026-10-01T11:00:00.000Z');
  const err = "src/nets.ts(12,7): error TS2304: Cannot find name 'MeshSize'.";
  s.user('Please get the build green again.')
    .say('Building.')
    .bash('toolu_cc4_b1', 'bun run build', err, 2)
    .say('Let me try the build again.')
    .bash('toolu_cc4_b2', 'bun run build', err, 2)
    .say('Retrying once more.')
    .bash('toolu_cc4_b3', 'bun  run   build', err, 2)
    .edit('toolu_cc4_e1', `${LN}/src/nets.ts`, "import { Net } from './types';", "import { Net, MeshSize } from './types';")
    .bash('toolu_cc4_b4', 'bun run build', 'built in 1.2s')
    .bash('toolu_cc4_g1', 'grep -rn "TODO(mesh)" src', '', 1);
  write('claude/repeated-fail.jsonl', s.rows);
}

// 5. honest multi-edit session: a normal edit loop that ends green
{
  const s = new CC('a1b2c3d4-5555-4555-8555-000000000005', TP, '2026-10-02T16:00:00.000Z');
  const f = `${TP}/src/csv.ts`;
  s.user('Add quoted-field support to the CSV reader.')
    .edit('toolu_cc5_e1', f, 'split(",")', 'splitQuoted(line)')
    .bash('toolu_cc5_t1', 'bun test tests/csv.test.ts', '3 pass\n2 fail\n  quoted comma', 1)
    .edit('toolu_cc5_e2', f, 'function splitQuoted', 'export function splitQuoted')
    .bash('toolu_cc5_t2', 'bun test tests/csv.test.ts', '4 pass\n1 fail\n  escaped quote', 1)
    .edit('toolu_cc5_e3', f, "if (c === '\"')", "if (c === '\"' && next === '\"')")
    .bash('toolu_cc5_t3', 'bun test tests/csv.test.ts', '5 pass\n0 fail')
    .edit('toolu_cc5_e4', f, '// TODO', '// handles RFC 4180 quoting')
    .say('Quoted fields work; all CSV tests pass.');
  write('claude/edit-loop.jsonl', s.rows);
}

// 6. expected failing test (red, then green) and a grep that finds nothing
{
  const s = new CC('a1b2c3d4-6666-4666-8666-000000000006', TP, '2026-10-03T10:00:00.000Z');
  s.user('Write a failing test for slugify first, then implement it.')
    .tool('toolu_cc6_w1', 'Write', { file_path: `${TP}/tests/slug.test.ts`, content: 'test("slug", () => {})' })
    .result('toolu_cc6_w1', 'File created successfully')
    .say('Running the new test; it should fail because slugify does not exist yet.')
    .bash('toolu_cc6_t1', 'bun test tests/slug.test.ts', '0 pass\n1 fail\n  slugify is not defined', 1)
    .bash('toolu_cc6_g1', 'grep -rn "slugify" src', '', 1)
    .tool('toolu_cc6_w2', 'Write', { file_path: `${TP}/src/slug.ts`, content: 'export const slugify = (s: string) => s;' })
    .result('toolu_cc6_w2', 'File created successfully')
    .bash('toolu_cc6_t2', 'bun test tests/slug.test.ts', '1 pass\n0 fail');
  write('claude/expected-fail.jsonl', s.rows);
}

// 7. a subagent thread: its user-role text is written by the parent agent, never by the human
{
  const s = new CC('a1b2c3d4-7777-4777-8777-000000000007', TP, '2026-10-03T12:00:00.000Z', 'main', true);
  s.user('Search the repo for every caller of parseDate and report them. Do not edit anything.')
    .bash('toolu_cc7_g1', 'rg -n parseDate src', 'src/a.ts:3: parseDate(x)');
  write('claude/subagents/agent-a7f00001.jsonl', s.rows);
}

// ---------------------------------------------------------------- Codex
class CX {
  rows: Row[] = [];
  private t: number;
  private ord = 0;
  constructor(start: string) {
    this.t = Date.parse(start);
  }
  row(type: string, payload: Row, extra: Row = {}): this {
    this.t += 5_000;
    this.rows.push({ timestamp: new Date(this.t).toISOString(), ordinal: this.ord++, type, payload, ...extra });
    return this;
  }
  msg(role: string, items: [kind: string | null, text: string][], extra: Row = {}, useKinds = true): this {
    const content = items.map(([, text]) => ({ type: role === 'assistant' ? 'output_text' : 'input_text', text }));
    const payload: Row = { type: 'message', id: `m${this.ord}`, role, content };
    if (useKinds && role !== 'assistant') payload.internal_chat_message_metadata_passthrough = { turn_id: 't', content_item_kinds: items.map(([k]) => k) };
    return this.row('response_item', payload, extra);
  }
}

const DESKTOP_META = (id: string, cwd: string, extra: Row = {}): Row => ({
  session_id: id,
  id,
  timestamp: '2026-09-30T07:00:00.000Z',
  cwd,
  originator: 'Codex Desktop',
  cli_version: '0.159.0',
  source: 'vscode',
  model_provider: 'openai',
  base_instructions: { text: 'You are a coding agent.' },
  ...extra,
});

// 8. Codex Desktop: turn_aborted → next user message, with an exec-embedded apply_patch
{
  const c = new CX('2026-09-30T07:00:00.000Z');
  const id = '0c0d0e0f-8888-7888-8888-000000000008';
  const patch = `*** Begin Patch\n*** Update File: src/api/routes.py\n@@\n-def get_user(id):\n+def fetch_user(id):\n*** End Patch`;
  c.row('session_meta', DESKTOP_META(id, '/home/dev/harbor'))
    .row('turn_context', { turn_id: 't1', cwd: '/home/dev/harbor', model: 'model-y' })
    .row('event_msg', { type: 'task_started', turn_id: 't1' })
    .msg('developer', [['permissions.instructions', '<permissions instructions>sandbox: workspace-write</permissions instructions>']])
    .msg('user', [
      ['agents_md.instructions', '# AGENTS.md instructions for /home/dev/harbor\n\n<INSTRUCTIONS>Use pytest.</INSTRUCTIONS>'],
      ['environments.environment_context', '<environment_context>\n  <cwd>/home/dev/harbor</cwd>\n</environment_context>'],
    ])
    .msg('user', [['user.text', 'Rename the internal user lookup helper to something clearer.']])
    .row('event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Rename…' }] } })
    .msg('assistant', [[null, 'I will rename the helper and update its callers.']])
    .row('response_item', { type: 'custom_tool_call', id: 'ct1', status: 'completed', call_id: 'call_x1', name: 'exec', input: 'const r = await tools.exec_command({cmd: "rg -n get_user src"});\ntext(r);' })
    .row('event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'CommandExecution', id: 'ce1', command: ['/bin/zsh', '-lc', 'rg -n get_user src'], cwd: '/home/dev/harbor', status: 'completed', aggregated_output: 'src/api/routes.py:4:def get_user(id):', exit_code: 0 } })
    .row('response_item', { type: 'custom_tool_call_output', id: 'o1', call_id: 'call_x1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' }, { type: 'input_text', text: 'src/api/routes.py:4' }] })
    .row('response_item', { type: 'custom_tool_call', id: 'ct2', status: 'completed', call_id: 'call_x2', name: 'exec', input: `const r = await tools.apply_patch(${JSON.stringify(patch)});\ntext(r);` })
    .row('event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'FileChange', id: 'fc1', changes: { 'src/api/routes.py': { type: 'update' } }, status: 'completed', stdout: '', stderr: '' } })
    .row('response_item', { type: 'custom_tool_call_output', id: 'o2', call_id: 'call_x2', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }] })
    .row('response_item', { type: 'custom_tool_call', id: 'ct3', status: 'completed', call_id: 'call_x3', name: 'exec', input: 'const r = await tools.exec_command({cmd: "sed -i s/get_user/fetch_user/g src/api/public.py"});' })
    .row('event_msg', { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted', started_at: 1, completed_at: 2, duration_ms: 1 })
    .msg('developer', [['generic.turn_aborted', '<turn_aborted>The user interrupted the previous turn.</turn_aborted>']])
    .row('event_msg', { type: 'task_started', turn_id: 't2' })
    .msg('user', [['user.text', 'no — keep the public API names in src/api/public.py unchanged. Rename only the internal helpers.']])
    .msg('assistant', [[null, 'Understood. Public names stay as they are.']])
    .row('event_msg', { type: 'task_complete', turn_id: 't2', last_agent_message: 'done' });
  write('codex/rollout-2026-09-30T07-00-00-0c0d0e0f-8888-7888-8888-000000000008.jsonl', c.rows);
}

// 9. Codex CLI shape: shell apply_patch, a repeated failing exec_command, interrupt → innocent pivot
{
  const c = new CX('2026-10-01T09:00:00.000Z');
  const id = '0c0d0e0f-9999-7999-8999-000000000009';
  const patch = `apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: app/models.py\n@@\n-    size = 3\n+    size = 4\n*** End Patch\nEOF`;
  c.row('session_meta', { id, timestamp: '2026-10-01T09:00:00.000Z', cwd: '/home/dev/orchard', originator: 'codex_cli_rs', cli_version: '0.50.0', git: { branch: 'fix/sizes' } })
    .msg('user', [[null, '<environment_context>\n  <cwd>/home/dev/orchard</cwd>\n</environment_context>']], {}, false)
    .msg('user', [[null, 'Bump the default basket size to 4 and make the tests pass.']], {}, false)
    .row('event_msg', { type: 'user_message', message: 'Bump the default basket size to 4 and make the tests pass.' })
    .row('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', patch], workdir: '/home/dev/orchard' }), call_id: 'call_p1' })
    .row('response_item', { type: 'function_call_output', call_id: 'call_p1', output: JSON.stringify({ output: 'Success. Updated the following files:\nM app/models.py\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }) })
    .row('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pytest -q tests/test_models.py' }), call_id: 'call_t1' })
    .row('response_item', { type: 'function_call_output', call_id: 'call_t1', output: 'Chunk ID: 1\nProcess exited with code 1\nOutput:\nE   ModuleNotFoundError: No module named orchard_conf' })
    .row('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pytest -q tests/test_models.py' }), call_id: 'call_t2' })
    .row('response_item', { type: 'function_call_output', call_id: 'call_t2', output: 'Chunk ID: 2\nProcess exited with code 1\nOutput:\nE   ModuleNotFoundError: No module named orchard_conf' })
    .row('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cd /home/dev/orchard && pytest -q tests/test_models.py' }), call_id: 'call_t3' })
    .row('response_item', { type: 'function_call_output', call_id: 'call_t3', output: 'Chunk ID: 3\nProcess exited with code 1\nOutput:\nE   ModuleNotFoundError: No module named orchard_conf' })
    .row('event_msg', { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' })
    .msg('user', [[null, '<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>']], {}, false)
    .msg('user', [[null, 'let us leave the tests for now and look at the README wording instead']], {}, false)
    .msg('assistant', [[null, 'Switching to the README.']]);
  write('codex/rollout-2026-10-01T09-00-00-0c0d0e0f-9999-7999-8999-000000000009.jsonl', c.rows);
}

// 10. Codex subagent thread: inherited and agent-authored user text, never human
{
  const c = new CX('2026-10-02T09:00:00.000Z');
  const id = '0c0d0e0f-aaaa-7aaa-8aaa-00000000000a';
  c.row('session_meta', DESKTOP_META(id, '/home/dev/harbor', { source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1, agent_role: 'worker' } } }, agent_role: 'worker' }))
    .msg('user', [['user.text', 'Rename the internal user lookup helper to something clearer.']], { metadata: { inherited_user_message: true } })
    .msg('user', [['user.text', 'You are a worker. Find every caller of get_user and report back. Never edit files.']])
    .row('response_item', { type: 'custom_tool_call', id: 'ct9', status: 'completed', call_id: 'call_s1', name: 'exec', input: 'await tools.exec_command({cmd:"rg -n get_user"})' })
    .row('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'ce9', command: ['/bin/zsh', '-lc', 'rg -n get_user'], status: 'completed', aggregated_output: '', exit_code: 1 } })
    .row('response_item', { type: 'custom_tool_call_output', call_id: 'call_s1', output: [{ type: 'input_text', text: 'Script completed\n' }] });
  write('codex/rollout-2026-10-02T09-00-00-0c0d0e0f-aaaa-7aaa-8aaa-00000000000a.jsonl', c.rows);
}

// 11. Codex Desktop, same project as fixture 4: the same build failing twice unchanged (cross-agent evidence)
{
  const c = new CX('2026-10-03T15:00:00.000Z');
  const id = '0c0d0e0f-bbbb-7bbb-8bbb-00000000000b';
  const err = "src/nets.ts(12,7): error TS2304: Cannot find name 'MeshSize'.";
  const run = (n: number, code: number, out: string) =>
    c
      .row('response_item', { type: 'custom_tool_call', id: `ct${n}`, status: 'completed', call_id: `call_b${n}`, name: 'exec', input: 'const r = await tools.exec_command({cmd: "bun run build"});\ntext(r);' })
      .row('event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'CommandExecution', id: `ceb${n}`, command: ['/bin/zsh', '-lc', 'bun run build'], cwd: LN, status: code === 0 ? 'completed' : 'failed', aggregated_output: out, exit_code: code } })
      .row('response_item', { type: 'custom_tool_call_output', call_id: `call_b${n}`, output: [{ type: 'input_text', text: 'Script completed\n' }] });
  c.row('session_meta', DESKTOP_META(id, LN))
    .msg('user', [['user.text', 'The build is red after the merge, please fix it.']])
    .msg('assistant', [[null, 'Running the build.']]);
  run(1, 2, err);
  c.msg('assistant', [[null, 'Running it again.']]);
  run(2, 2, err);
  c.row('response_item', { type: 'custom_tool_call', id: 'ctp', status: 'completed', call_id: 'call_bp', name: 'exec', input: `await tools.apply_patch(${JSON.stringify("*** Begin Patch\n*** Update File: src/nets.ts\n@@\n-import { Net } from './types';\n+import { Net, MeshSize } from './types';\n*** End Patch")});` })
    .row('event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'FileChange', id: 'fcb', changes: { 'src/nets.ts': { type: 'update' } }, status: 'completed' } })
    .row('response_item', { type: 'custom_tool_call_output', call_id: 'call_bp', output: [{ type: 'input_text', text: 'Script completed\n' }] });
  run(3, 0, 'built in 1.1s');
  write('codex/rollout-2026-10-03T15-00-00-0c0d0e0f-bbbb-7bbb-8bbb-00000000000b.jsonl', c.rows);
}

// ---------------------------------------------------------------- engine leg fixtures (noise filter, types 3–5)

const OR = '/home/dev/orchard';

// 12. Named negatives (Claude): harness rejection, permission denial, worktree refusal, pipeline grep with no match.
//     Each happens twice with nothing changed; none of them is an unsuccessful command.
{
  const s = new CC('a1b2c3d4-c0c0-4c0c-8c0c-00000000000c', TP, '2026-10-04T09:00:00.000Z');
  const rejected = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  const denied = 'Permission to use Bash with command rm -rf build has been denied.';
  const worktree = 'This session is isolated in the worktree /home/dev/wt/tidepool-fix, but this command targets /home/dev/tidepool. Run it inside the worktree instead.';
  s.user('Tidy up the build output and push the branch.');
  for (const n of [1, 2]) {
    s.tool(`toolu_ccc_p${n}`, 'Bash', { command: 'git push --force origin main' }).result(`toolu_ccc_p${n}`, rejected, { isError: true, tur: 'User rejected tool use' });
  }
  for (const n of [1, 2]) {
    s.tool(`toolu_ccc_r${n}`, 'Bash', { command: 'rm -rf build' }).result(`toolu_ccc_r${n}`, denied, { isError: true, tur: `Error: ${denied}` });
  }
  for (const n of [1, 2]) {
    s.tool(`toolu_ccc_s${n}`, 'Bash', { command: `cd ${TP} && git status --short` }).result(`toolu_ccc_s${n}`, worktree, { isError: true, tur: `Error: ${worktree}` });
  }
  for (const n of [1, 2]) s.bash(`toolu_ccc_g${n}`, 'cat build.log | grep -n ERROR', '', 1);
  s.say('Nothing was pushed or removed; the log has no errors.');
  write('claude/noise-negatives.jsonl', s.rows);
}

// 13. Named negatives (Codex CLI): a declined exec twice and a sandbox denial twice; neither is a failure.
{
  const c = new CX('2026-10-04T10:00:00.000Z');
  c.row('session_meta', { id: '0c0d0e0f-cccc-7ccc-8ccc-00000000000c', timestamp: '2026-10-04T10:00:00.000Z', cwd: OR, originator: 'codex_cli_rs', cli_version: '0.50.0' })
    .msg('user', [[null, 'Deploy the staging build.']], {}, false);
  for (const n of [1, 2]) {
    c.row('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'make deploy-staging' }), call_id: `call_d${n}` })
      .row('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: `ced${n}`, command: ['bash', '-lc', 'make deploy-staging'], status: 'declined', aggregated_output: '' } })
      .row('response_item', { type: 'function_call_output', call_id: `call_d${n}`, output: 'exec command rejected by user' });
  }
  for (const n of [1, 2]) {
    c.row('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'curl -fsS https://example.test/health' }), call_id: `call_n${n}` })
      .row('response_item', { type: 'function_call_output', call_id: `call_n${n}`, output: JSON.stringify({ output: 'network access denied by the sandbox policy', metadata: { exit_code: 1 } }) });
  }
  c.msg('assistant', [[null, 'The deploy needs your approval and network access; nothing ran.']]);
  write('codex/rollout-2026-10-04T10-00-00-0c0d0e0f-cccc-7ccc-8ccc-00000000000c.jsonl', c.rows);
}

// 14. Type 3 POSITIVE (Claude): three edits to one file, the fourth is cut off by the person, who then draws a line.
{
  const s = new CC('a1b2c3d4-d0d0-4d0d-8d0d-00000000000d', LN, '2026-10-04T11:00:00.000Z');
  const f = `${LN}/src/parse/mesh.ts`;
  s.user('The mesh parser rejects sizes with a unit suffix. Fix that.')
    .edit('toolu_ccd_e1', f, 'parseInt(raw)', 'parseFloat(raw)')
    .edit('toolu_ccd_e2', f, 'export function parseMesh', 'export function parseMeshSize')
    .edit('toolu_ccd_e3', f, 'const UNITS = []', "const UNITS = ['mm', 'cm']")
    .tool('toolu_ccd_e4', 'Edit', { file_path: f, old_string: 'export function parseMeshSize', new_string: 'export class MeshParser', replace_all: false })
    .userBlocks([{ type: 'text', text: '[Request interrupted by user for tool use]' }])
    .user('stop rewriting the parser. only change the unit regex, nothing else in that file.')
    .edit('toolu_ccd_e5', f, '/^\\d+$/', '/^\\d+(mm|cm)?$/');
  write('claude/edit-rewrite.jsonl', s.rows);
}

// 15. Type 3 dedupe (Codex Desktop): code-mode patches with FileChange children count once per patch.
//     Three patches to one file → one candidate of three edits; a second file patched twice → nothing.
{
  const c = new CX('2026-10-04T12:00:00.000Z');
  const id = '0c0d0e0f-dddd-7ddd-8ddd-00000000000d';
  c.row('session_meta', DESKTOP_META(id, OR)).msg('user', [['user.text', 'Make the basket totals round to cents.']]);
  const patchOnce = (n: number, file: string) => {
    const p = `*** Begin Patch\n*** Update File: ${file}\n@@\n-    total = ${n}\n+    total = ${n + 1}\n*** End Patch`;
    c.row('response_item', { type: 'custom_tool_call', id: `ctd${n}`, status: 'completed', call_id: `call_dp${n}`, name: 'exec', input: `await tools.apply_patch(${JSON.stringify(p)});` })
      .row('event_msg', { type: 'item_completed', item: { type: 'FileChange', id: `fcd${n}`, changes: { [file]: { type: 'update' } }, status: 'completed' } })
      .row('response_item', { type: 'custom_tool_call_output', call_id: `call_dp${n}`, output: [{ type: 'input_text', text: 'Script completed\n' }] });
  };
  patchOnce(1, 'app/basket.py');
  patchOnce(2, 'app/basket.py');
  patchOnce(3, 'app/money.py');
  patchOnce(4, 'app/basket.py');
  patchOnce(5, 'app/money.py');
  c.msg('assistant', [[null, 'Totals now round to cents.']]);
  write('codex/rollout-2026-10-04T12-00-00-0c0d0e0f-dddd-7ddd-8ddd-00000000000d.jsonl', c.rows);
}

// 16. Type 4 POSITIVES: the same genuine directive in two sessions (Claude, then Codex), near-duplicate wording.
//     NEGATIVES in the same files: the directive repeated inside one session only, and the same words inside an
//     injected continuation summary (quarantined, never a member).
{
  const s = new CC('a1b2c3d4-e0e0-4e0e-8e0e-00000000000e', OR, '2026-10-05T09:00:00.000Z');
  s.user('This session is being continued from a previous conversation. Summary: please use uv, never pip, for installs in this repo.', { isCompactSummary: true })
    .user('please use uv, never pip, for installs in this repo')
    .bash('toolu_cce_i1', 'uv add httpx', 'Resolved 4 packages')
    .user('keep the changelog entries in past tense from now on')
    .user('keep the changelog entries in past tense from now on')
    .say('Noted.');
  write('claude/directive-a.jsonl', s.rows);
  const c = new CX('2026-10-05T14:00:00.000Z');
  c.row('session_meta', { id: '0c0d0e0f-eeee-7eee-8eee-00000000000e', timestamp: '2026-10-05T14:00:00.000Z', cwd: OR, originator: 'codex_cli_rs', cli_version: '0.50.0' })
    .msg('user', [[null, 'Please use uv and never pip for installs in this repo.']], {}, false)
    .row('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'uv add rich' }), call_id: 'call_e1' })
    .row('response_item', { type: 'function_call_output', call_id: 'call_e1', output: 'Process exited with code 0\nOutput:\nResolved 2 packages' })
    .msg('user', [[null, 'use the new logger here as well']], {}, false);
  write('codex/rollout-2026-10-05T14-00-00-0c0d0e0f-eeee-7eee-8eee-00000000000e.jsonl', c.rows);
}

// 17. Type 5 POSITIVES: the narrow workflow (focused passing test → diff review → report with the result) in a Claude
//     session and a Codex CLI session. NEGATIVES in a third session: a whole-suite run, a failing focused test, and a
//     report written before the diff.
{
  const s = new CC('a1b2c3d4-f0f0-4f0f-8f0f-00000000000f', TP, '2026-10-05T10:00:00.000Z');
  s.user('Fix the off-by-one in the pager.')
    .edit('toolu_ccf_e1', `${TP}/src/pager.ts`, 'i <= n', 'i < n')
    .bash('toolu_ccf_t1', 'bun test tests/pager.test.ts', '6 pass\n0 fail')
    .bash('toolu_ccf_d1', 'git diff --stat', ' src/pager.ts | 2 +-\n 1 file changed')
    .bash('toolu_ccf_d2', 'git diff', 'diff --git a/src/pager.ts b/src/pager.ts\n-  for (i = 0; i <= n; i++)\n+  for (i = 0; i < n; i++)')
    .say('Changed src/pager.ts; tests/pager.test.ts passes (6 pass, 0 fail).');
  write('claude/workflow-a.jsonl', s.rows);

  const c = new CX('2026-10-05T16:00:00.000Z');
  c.row('session_meta', { id: '0c0d0e0f-ffff-7fff-8fff-00000000000f', timestamp: '2026-10-05T16:00:00.000Z', cwd: OR, originator: 'codex_cli_rs', cli_version: '0.50.0' })
    .msg('user', [[null, 'The basket total test is red, fix it.']], {}, false)
    .row('response_item', { type: 'function_call', name: 'exec', arguments: JSON.stringify({ cmd: "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: app/basket.py\n@@\n-    return total\n+    return round(total, 2)\n*** End Patch\nEOF", workdir: OR }), call_id: 'call_f1' })
    .row('response_item', { type: 'function_call_output', call_id: 'call_f1', output: 'The file /home/dev/orchard/app/basket.py has been edited.' })
    .row('response_item', { type: 'function_call', name: 'exec', arguments: JSON.stringify({ cmd: 'pytest tests/test_basket.py -q', workdir: OR }), call_id: 'call_f2' })
    .row('response_item', { type: 'function_call_output', call_id: 'call_f2', output: '3 passed in 0.21s\n' })
    .row('response_item', { type: 'function_call', name: 'exec', arguments: JSON.stringify({ cmd: 'git diff', workdir: OR }), call_id: 'call_f3' })
    .row('response_item', { type: 'function_call_output', call_id: 'call_f3', output: 'diff --git a/app/basket.py b/app/basket.py\n-    return total\n+    return round(total, 2)\n' })
    .msg('assistant', [[null, 'Fixed app/basket.py; tests/test_basket.py passes (3 passed).']]);
  write('codex/rollout-2026-10-05T16-00-00-0c0d0e0f-ffff-7fff-8fff-00000000000f.jsonl', c.rows);

  const n = new CC('a1b2c3d4-f1f1-4f1f-8f1f-0000000000f1', TP, '2026-10-05T18:00:00.000Z');
  n.user('Fix the date header.')
    .edit('toolu_ccn_e1', `${TP}/src/header.ts`, 'toUTCString()', 'toISOString()')
    .bash('toolu_ccn_t1', 'bun test', '120 pass\n0 fail')
    .bash('toolu_ccn_d1', 'git diff', 'diff --git a/src/header.ts b/src/header.ts')
    .say('Changed src/header.ts; the whole suite passes (120 pass).')
    .user('Now fix the footer.')
    .edit('toolu_ccn_e2', `${TP}/src/footer.ts`, 'year', 'fullYear')
    .bash('toolu_ccn_t2', 'bun test tests/footer.test.ts', '1 pass\n1 fail', 1)
    .bash('toolu_ccn_d2', 'git diff', 'diff --git a/src/footer.ts b/src/footer.ts')
    .say('Changed src/footer.ts; tests/footer.test.ts still fails (1 fail).')
    .user('And the sidebar.')
    .edit('toolu_ccn_e3', `${TP}/src/sidebar.ts`, 'width: 200', 'width: 240')
    .say('Changed src/sidebar.ts; tests/sidebar.test.ts passes (2 pass).')
    .bash('toolu_ccn_t3', 'bun test tests/sidebar.test.ts', '2 pass\n0 fail')
    .bash('toolu_ccn_d3', 'git diff', 'diff --git a/src/sidebar.ts b/src/sidebar.ts');
  write('claude/workflow-negatives.jsonl', n.rows);
}

console.log('fixtures written');
