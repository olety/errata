// One entry point for both agents. Used by the Web Worker in the app and directly by tests and scripts.

import type { Agent, Session } from '../model';
import { ClaudeParser, type ParseMeta } from './claude';
import { CodexParser } from './codex';
import { readSessionLines, type BlobLike, type ReadOptions } from './lines';
import { annotateSession } from '../noise';

export interface SessionFile {
  /** Path relative to the granted root, '/'-separated (used for agent detection and subagent tagging). */
  rel: string;
  blob: BlobLike;
}

/** Detect the agent from the relative path. Codex rollouts are rollout-*.jsonl; everything else is Claude Code. */
export function agentForPath(rel: string): Agent {
  const name = rel.split('/').pop() ?? rel;
  return /^rollout-.*\.jsonl$/.test(name) ? 'codex' : 'claude';
}

/** Detect from content when the path is not decisive (drag-dropped files). */
export function agentForFirstLine(line: string): Agent | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o && typeof o === 'object' && 'payload' in o) return 'codex';
    if (o && typeof o === 'object' && ('sessionId' in o || 'message' in o || 'parentUuid' in o)) return 'claude';
  } catch {
    /* ignore */
  }
  return null;
}

/** Parse one session file with a full incremental read. Cancellable through opts.signal. */
export async function parseSessionFile(f: SessionFile, agent?: Agent, opts: ReadOptions = {}): Promise<Session> {
  const name = f.rel.split('/').pop() ?? f.rel;
  const a = agent ?? agentForPath(f.rel);
  const meta: ParseMeta = { file: name, agentAuthored: /(^|\/)subagents\//.test(f.rel) || /^agent-/.test(name) };
  const parser = a === 'codex' ? new CodexParser(meta) : new ClaudeParser(meta);
  await readSessionLines(f.blob, { line: (t) => parser.push(t), oversized: () => parser.oversized() }, opts);
  return annotateSession(parser.finish());
}

/** Parse lines already in memory (tests, fixtures). */
export function parseLines(agent: Agent, file: string, lines: string[], agentAuthored = false): Session {
  const parser = agent === 'codex' ? new CodexParser({ file, agentAuthored }) : new ClaudeParser({ file, agentAuthored });
  for (const l of lines) if (l.trim()) parser.push(l);
  return annotateSession(parser.finish());
}
