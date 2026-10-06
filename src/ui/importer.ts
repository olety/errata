// Choosing session files. Folder walks are allow-listed: under the Claude folder only projects/**/*.jsonl,
// under the Codex sessions folder only rollout-*.jsonl. Nothing else is opened.

import type { Agent } from '../model';
import { MAX_IMPORT_BYTES } from '../model';
import { agentForFirstLine } from '../parse/index';

export interface Candidate {
  rel: string;
  agent: Agent;
  file: File;
  /** Subagent threads are offered last and skipped by default. */
  subagent: boolean;
}

async function* walk(dir: FileSystemDirectoryHandle, prefix: string, depth: number, accept: (rel: string) => boolean, descend: (rel: string) => boolean): AsyncGenerator<{ rel: string; handle: FileSystemFileHandle }> {
  if (depth > 6) return;
  // @ts-expect-error: entries() is not in every lib.dom version
  for await (const [name, h] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'directory') {
      if (descend(rel)) yield* walk(h as FileSystemDirectoryHandle, rel, depth + 1, accept, descend);
    } else if (accept(rel)) {
      yield { rel, handle: h as FileSystemFileHandle };
    }
  }
}

/** The player picked their ~/.claude folder. Only projects/**.jsonl is read. */
export async function claudeCandidates(root: FileSystemDirectoryHandle): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const descend = (rel: string) => rel === 'projects' || rel.startsWith('projects/');
  const accept = (rel: string) => rel.startsWith('projects/') && rel.endsWith('.jsonl');
  for await (const { rel, handle } of walk(root, '', 0, accept, descend)) {
    out.push({ rel, agent: 'claude', file: await handle.getFile(), subagent: /\/subagents\//.test(rel) });
  }
  return out;
}

/** The player picked ~/.codex/sessions. Only rollout-*.jsonl is read. */
export async function codexCandidates(root: FileSystemDirectoryHandle): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const accept = (rel: string) => /(^|\/)rollout-[^/]*\.jsonl$/.test(rel);
  for await (const { rel, handle } of walk(root, '', 0, accept, () => true)) {
    out.push({ rel, agent: 'codex', file: await handle.getFile(), subagent: false });
  }
  return out;
}

/** Dropped files: the agent is read from the first line. */
export async function droppedCandidates(files: File[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const f of files) {
    if (!f.name.endsWith('.jsonl')) continue;
    const head = await f.slice(0, 1 << 20).text();
    const agent = agentForFirstLine(head.split('\n')[0] ?? '') ?? (f.name.startsWith('rollout-') ? 'codex' : 'claude');
    out.push({ rel: f.name, agent, file: f, subagent: f.name.startsWith('agent-') });
  }
  return out;
}

export interface Selection {
  chosen: Candidate[];
  excluded: { tooOld: number; subagent: number; overBudget: number; overPerAgent: number };
  window: { days: number; perAgent: number };
}

/** Last 14 days, newest first, up to 12 per agent (24 total), subagent threads out, 128 MiB budget. */
export function selectRun(all: Candidate[], days = 14, perAgent = 12, now = Date.now()): Selection {
  const since = now - days * 86400_000;
  const ex = { tooOld: 0, subagent: 0, overBudget: 0, overPerAgent: 0 };
  const chosen: Candidate[] = [];
  let bytes = 0;
  const per: Record<Agent, number> = { claude: 0, codex: 0 };
  for (const c of [...all].sort((a, b) => b.file.lastModified - a.file.lastModified)) {
    if (c.file.lastModified < since) {
      ex.tooOld++;
      continue;
    }
    if (c.subagent) {
      ex.subagent++;
      continue;
    }
    if (per[c.agent] >= perAgent) {
      ex.overPerAgent++;
      continue;
    }
    const cost = Math.min(c.file.size, 8 * 1024 * 1024 + (1 << 20));
    if (bytes + cost > MAX_IMPORT_BYTES) {
      ex.overBudget++;
      continue;
    }
    bytes += cost;
    per[c.agent]++;
    chosen.push(c);
  }
  return { chosen, excluded: ex, window: { days, perAgent } };
}
