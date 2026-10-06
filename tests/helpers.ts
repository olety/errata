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
  noise: 'claude/noise-negatives.jsonl',
  noiseHarness: 'claude/noise-harness.jsonl',
  rewrite: 'claude/edit-rewrite.jsonl',
  directiveA: 'claude/directive-a.jsonl',
  workflowA: 'claude/workflow-a.jsonl',
  workflowNeg: 'claude/workflow-negatives.jsonl',
};
export const CX = {
  desktop: 'codex/rollout-2026-09-30T07-00-00-0c0d0e0f-8888-7888-8888-000000000008.jsonl',
  cli: 'codex/rollout-2026-10-01T09-00-00-0c0d0e0f-9999-7999-8999-000000000009.jsonl',
  subagent: 'codex/rollout-2026-10-02T09-00-00-0c0d0e0f-aaaa-7aaa-8aaa-00000000000a.jsonl',
  build: 'codex/rollout-2026-10-03T15-00-00-0c0d0e0f-bbbb-7bbb-8bbb-00000000000b.jsonl',
  noise: 'codex/rollout-2026-10-04T10-00-00-0c0d0e0f-cccc-7ccc-8ccc-00000000000c.jsonl',
  dedupe: 'codex/rollout-2026-10-04T12-00-00-0c0d0e0f-dddd-7ddd-8ddd-00000000000d.jsonl',
  directiveB: 'codex/rollout-2026-10-05T14-00-00-0c0d0e0f-eeee-7eee-8eee-00000000000e.jsonl',
  workflowB: 'codex/rollout-2026-10-05T16-00-00-0c0d0e0f-ffff-7fff-8fff-00000000000f.jsonl',
};

/** The slice's original eleven fixtures (counts in older tests are over these). */
export const SLICE = {
  CC: ['directive', 'pivot', 'injected', 'repeated', 'editLoop', 'expected', 'subagent'] as const,
  CX: ['desktop', 'cli', 'subagent', 'build'] as const,
};

export async function sliceFixtures(): Promise<Session[]> {
  return Promise.all([...SLICE.CC.map((k) => CC[k]), ...SLICE.CX.map((k) => CX[k])].map(fixture));
}

export async function allFixtures(): Promise<Session[]> {
  return Promise.all([...Object.values(CC), ...Object.values(CX)].map(fixture));
}

// ------------------------------------------------------------------ the synthetic sample through the real pipeline
import { readFileSync } from 'node:fs';
import { analyse, type Analysis } from '../src/pipeline';
import { newDeck } from '../src/deck/deck';

export const SAMPLE_ROOT = join(import.meta.dir, '..', 'public', 'sample');
export interface SampleManifest {
  sessions: { session: string; file: string; agent: 'claude' | 'codex'; project: string }[];
  expected_outcomes: { session: string; expects: Record<string, unknown> }[];
}
export const sampleManifest = (): SampleManifest => JSON.parse(readFileSync(join(SAMPLE_ROOT, 'manifest.json'), 'utf8'));
export const sampleClaudeMd = () => new Uint8Array(readFileSync(join(SAMPLE_ROOT, 'home/.claude/CLAUDE.md')));
export const sampleAgentsMd = () => new Uint8Array(readFileSync(join(SAMPLE_ROOT, 'home/.codex/AGENTS.md')));

/** The sample analysed as the app does it, with a session-id → "S01" label map. */
export async function sampleAnalysis(): Promise<Analysis & { labels: Map<string, string> }> {
  const m = sampleManifest();
  const sessions: Session[] = [];
  for (const s of m.sessions) sessions.push(await parseSessionFile({ rel: s.file.replace(/^home\/\.(?:claude|codex)\//, ''), blob: Bun.file(join(SAMPLE_ROOT, s.file)) }));
  const A = analyse(sessions, { importedCards: newDeck(sampleClaudeMd(), sampleAgentsMd()).imported.length });
  return Object.assign(A, { labels: new Map(m.sessions.map((s, i) => [sessions[i]!.id, s.session])) });
}
