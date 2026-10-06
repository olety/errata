// Choosing session files. Folder walks are allow-listed: under the Claude folder only projects/**/*.jsonl,
// under the Codex sessions folder only rollout-*.jsonl. Nothing else is opened.

import type { Agent } from '../model';
import { READ_BYTES_PER_SEC, SOFT_IMPORT_BYTES } from '../model';
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

/** A Codex rollout's first line names a subagent thread in session_meta.source. Read only that line's head. */
async function codexSubagent(file: File): Promise<boolean> {
  try {
    const head = await file.slice(0, 64 * 1024).text();
    const first = head.split('\n')[0] ?? '';
    const src = (JSON.parse(first) as { payload?: { source?: unknown } })?.payload?.source;
    return !!src && typeof src === 'object' && 'subagent' in (src as object);
  } catch {
    return false; // an unreadable or very long first line: read it in full later; the parser decides
  }
}

/** The player picked ~/.codex/sessions. Only rollout-*.jsonl is read; recent files are checked for subagent threads. */
export async function codexCandidates(root: FileSystemDirectoryHandle, recentDays = 30, now = Date.now()): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const accept = (rel: string) => /(^|\/)rollout-[^/]*\.jsonl$/.test(rel);
  for await (const { rel, handle } of walk(root, '', 0, accept, () => true)) {
    const file = await handle.getFile();
    const recent = file.lastModified >= now - recentDays * 86400_000;
    out.push({ rel, agent: 'codex', file, subagent: recent ? await codexSubagent(file) : false });
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
  excluded: { tooOld: number; subagent: number; overPerAgent: number };
  window: { days: number; perAgent: number };
  /** Total bytes the run will read in full. */
  bytes: number;
  /** Over the 128 MiB guide: a warning with a time estimate, never a stop. */
  overSoftBound: boolean;
  estimateSec: number;
  dates: { from: number | null; to: number | null };
}

/** Last 14 days, newest first, up to 12 per agent (24 total), subagent threads out. Size is a warning, never a cut. */
export function selectRun(all: Candidate[], days = 14, perAgent = 12, now = Date.now()): Selection {
  const since = now - days * 86400_000;
  const ex = { tooOld: 0, subagent: 0, overPerAgent: 0 };
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
    bytes += c.file.size;
    per[c.agent]++;
    chosen.push(c);
  }
  const times = chosen.map((c) => c.file.lastModified);
  return {
    chosen,
    excluded: ex,
    window: { days, perAgent },
    bytes,
    overSoftBound: bytes > SOFT_IMPORT_BYTES,
    estimateSec: Math.ceil(bytes / READ_BYTES_PER_SEC),
    dates: { from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null },
  };
}
