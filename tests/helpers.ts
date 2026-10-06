import { join } from 'node:path';
import { parseSessionFile } from '../src/parse/index';
import type { Session } from '../src/model';

export const FIX = join(import.meta.dir, '..', 'fixtures');

export async function fixture(rel: string): Promise<Session> {
  return parseSessionFile({ rel, blob: Bun.file(join(FIX, rel)) });
}

export const CC = {
  directive: 'claude/interrupt-directive.jsonl',
  pivot: 'claude/interrupt-pivot.jsonl',
  injected: 'claude/injected.jsonl',
  repeated: 'claude/repeated-fail.jsonl',
  editLoop: 'claude/edit-loop.jsonl',
  expected: 'claude/expected-fail.jsonl',
  subagent: 'claude/subagents/agent-a7f00001.jsonl',
};
export const CX = {
  desktop: 'codex/rollout-2026-09-30T07-00-00-0c0d0e0f-8888-7888-8888-000000000008.jsonl',
  cli: 'codex/rollout-2026-10-01T09-00-00-0c0d0e0f-9999-7999-8999-000000000009.jsonl',
  subagent: 'codex/rollout-2026-10-02T09-00-00-0c0d0e0f-aaaa-7aaa-8aaa-00000000000a.jsonl',
};
