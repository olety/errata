// Synthetic only: fixed seed, fixed timestamps, invented commands and files. No input logs are read.
export const ROLLOUT_BYTES = 54 * 1_048_576;
export const ROLLOUT_SEED = 0x54c0de;
const KIB = 1024;

/** Write one rollout incrementally; the final turn can overshoot the target by at most ~200 KiB. */
export async function generateRollout(path: string): Promise<{ bytes: number; turns: number; lines: number }> {
  const writer = Bun.file(path).writer();
  let state = ROLLOUT_SEED;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  let bytes = 0;
  let lines = 0;
  let turns = 0;
  const epoch = Date.parse('2026-01-01T09:00:00.000Z');
  const cwd = '/home/dev/lorem-garden';
  const row = (type: string, payload: object) => {
    const text = JSON.stringify({ timestamp: new Date(epoch + lines * 1000).toISOString(), type, payload }) + '\n';
    writer.write(text);
    bytes += Buffer.byteLength(text);
    lines++;
  };
  const message = (role: 'user' | 'assistant', text: string) => row('response_item', {
    type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    ...(role === 'user' ? { internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } : {}),
  });
  try {
    row('session_meta', {
      id: '00000054-0000-4000-8000-000000000001', timestamp: new Date(epoch).toISOString(), cwd,
      originator: 'codex_cli_rs', source: 'cli', git: { branch: 'synthetic/lorem-garden' },
    });
    while (bytes < ROLLOUT_BYTES) {
      const n = turns++;
      const file = `tests/petal-${n % 17}.test.ts`;
      const command = `bun test ${file}`;
      const callId = `synthetic-call-${n}`;
      const interrupted = n > 0 && n % 71 === 0;
      const exitCode = n % 11 === 0 ? 2 : 0;
      row('turn_context', { turn_id: `turn-${n}`, cwd });
      message('user', `Check the invented petal module ${n} and keep the garden interface unchanged.`);
      message('assistant', `I will inspect ${file} and run its synthetic checks.`);
      const outputBytes = (20 + random() % 181) * KIB;
      const header = interrupted ? 'aborted by user\n' :
        `Chunk ID: synthetic-${n}\nProcess exited with code ${exitCode}\nOutput:\n` +
        (exitCode ? `error: synthetic petal assertion failed in ${file}\n` : `pass: synthetic checks for ${file}\n`);
      const text = `${file}: lorem ipsum dolor sit amet, consectetur adipiscing elit; petal ${random() % 1000} verified.\n`;
      const bodySize = outputBytes - header.length;
      const output = header + text.repeat(Math.ceil(bodySize / text.length)).slice(0, bodySize);
      switch (n % 4) {
        case 0:
          row('response_item', { type: 'function_call', name: 'exec', arguments: JSON.stringify({ cmd: command, workdir: cwd }), call_id: callId });
          row('response_item', { type: 'function_call_output', call_id: callId, output });
          break;
        case 1:
          row('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: command }), call_id: callId });
          row('response_item', { type: 'function_call_output', call_id: callId,
            output: interrupted ? output : JSON.stringify({ output, metadata: { exit_code: exitCode, duration_seconds: 0.1 } }) });
          break;
        case 2:
          row('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command], workdir: cwd }), call_id: callId });
          row('response_item', { type: 'function_call_output', call_id: callId, output: interrupted ? 'aborted by user' : `Process exited with code ${exitCode}` });
          row('event_msg', { type: 'exec_command_end', call_id: callId, exit_code: interrupted ? 130 : exitCode, aggregated_output: output });
          break;
        default:
          row('response_item', { type: 'custom_tool_call', name: 'exec', call_id: callId,
            input: `const r = await tools.exec_command({cmd: ${JSON.stringify(command)}}); text(r);` });
          row('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: `synthetic-command-${n}`,
            command: ['/bin/zsh', '-lc', command], status: interrupted || exitCode ? 'failed' : 'completed',
            exit_code: interrupted ? 130 : exitCode, aggregated_output: output } });
          row('response_item', { type: 'custom_tool_call_output', call_id: callId,
            output: [{ type: 'input_text', text: interrupted ? 'aborted by user' : exitCode ? 'Script failed' : 'Script completed' }] });
      }
      if (interrupted) row('event_msg', { type: 'turn_aborted', turn_id: `turn-${n}`, reason: 'interrupted' });
      message('assistant', interrupted ? 'The check was interrupted; I will wait for the next instruction.' :
        exitCode ? 'The synthetic check failed; the next pass will inspect the petal assertion.' : 'The synthetic checks passed.');
      await writer.flush();
    }
  } finally {
    await writer.end();
  }
  return { bytes, turns, lines };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: bun run scripts/gen-rollout.ts <output-path>');
    process.exit(1);
  }
  const result = await generateRollout(path);
  console.log(`Generated ${result.bytes} bytes, ${result.turns} turns, ${result.lines} lines.`);
}
