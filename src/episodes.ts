// Deterministic episode detection (spec §2). This slice: type 1 (interrupt → next genuine human message)
// and type 2 (repeated unsuccessful command). Types 3–5 are later legs; their seams are marked below.
// An episode is a candidate. Nothing here declares a problem: every case starts 'unreviewed'.

import type { Agent, Session, ToolCall, Turn } from './model';
import { allCalls, gapBetween } from './model';
import { commandPrefixOf, fingerprint, programOf } from './parse/common';

export const QUOTE_LIMIT = 200;

export interface Receipt {
  /** The human's words (≤200 chars), or null → "Tool evidence only". */
  quote: string | null;
  /** The adjacent action: tool name + command/files, already redacted. */
  action: string | null;
  /** The adjacent result: status + exit code + redacted head. */
  result: string | null;
}

interface EpisodeBase {
  id: string;
  /** Canonical session id. */
  sessionId: string;
  agent: Agent;
  /** Opaque project identity of the anchor turn. */
  projectKey: string | null;
  /** Display chip, only when the anchor's project is the session's own. */
  projectLabel: string | null;
  /** Turn index of the anchor. */
  turn: number;
  ts: string | null;
  receipt: Receipt;
}

export interface InterruptEpisode extends EpisodeBase {
  type: 'interrupt';
  interrupt: NonNullable<Turn['interrupt']>;
  /** Index of the paired genuine human turn. Null when the session never got one or a gap lies in between. */
  humanTurn: number | null;
  /** A source gap (dropped row, tail window) lay between the interrupt and the next human message. */
  crossesGap: boolean;
  /** Injected turns skipped between the interrupt and the human message (quarantine at work). */
  skippedInjected: number;
  /** Seconds between interrupt and human message, null when either timestamp is missing. */
  gapSec: number | null;
  /** The call that was cut off or rejected, when there was one. */
  interruptedCall: ToolCall | null;
  /** The human message looks like pasted material (long or many lines), not a typed directive. */
  pasted: boolean;
}

export interface RepeatedCommandEpisode extends EpisodeBase {
  type: 'repeated-command';
  fingerprint: string;
  program: string | null;
  /** "bun test", "pytest -q": the card trigger prefix. */
  prefix: string;
  /** Call ids of the unchanged failing runs, in order (≥2). */
  failures: string[];
  /** A later run of the same fingerprint succeeded. */
  laterSuccess: boolean;
}

export type Episode = InterruptEpisode | RepeatedCommandEpisode;
// Seams for the 12–24 h leg: 'edit-sequence' (type 3), 'directive' (type 4), 'workflow' (type 5).

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function describeCall(c: ToolCall | null): string | null {
  if (!c) return null;
  if (c.command) return `${c.name}: ${clip(c.command, 160)}`;
  if (c.files.length) return `${c.name}: ${c.files.map((f) => f.split('/').slice(-2).join('/')).join(', ')}`;
  return c.name;
}

export function describeResult(c: ToolCall | null): string | null {
  if (!c) return null;
  if (!c.result) return 'no result recorded';
  const code = c.result.exitCode !== null ? ` (exit ${c.result.exitCode})` : '';
  const head = c.result.text ? ` — ${clip(c.result.text, 140)}` : '';
  return `${c.result.status}${code}${head}`;
}

/** Long or many-line human text is usually pasted material: a report, a doc, a log. */
export function isPasted(text: string): boolean {
  return text.length > 400 || text.split('\n').length > 5;
}

function gap(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const d = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isFinite(d) ? Math.round(d) : null;
}

/** Type 1: every interrupt paired with the next genuine human message. Injected turns are skipped, never paired. */
export function interruptEpisodes(s: Session): InterruptEpisode[] {
  if (s.agentAuthored) return [];
  const out: InterruptEpisode[] = [];
  const turns = s.turns;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role !== 'interrupt') continue;
    let skipped = 0;
    let human: Turn | null = null;
    let superseded = false;
    for (let j = i + 1; j < turns.length; j++) {
      const u = turns[j]!;
      if (u.role === 'interrupt') {
        superseded = true; // a later interrupt owns the next message
        break;
      }
      if (u.role === 'injected') {
        skipped++;
        continue;
      }
      if (u.role === 'human') {
        human = u;
        break;
      }
    }
    if (superseded) continue;
    const crossesGap = human !== null && gapBetween(s, t.seq, human.seq);
    if (crossesGap) human = null;
    // The adjacent action: the last call in the closest assistant turn before the interrupt.
    let cut: ToolCall | null = null;
    for (let k = i - 1; k >= 0 && !cut; k--) {
      const a = turns[k]!;
      if (a.role === 'human') break;
      if (a.role === 'assistant' && a.calls.length) cut = a.calls[a.calls.length - 1]!;
    }
    out.push({
      id: `${s.id}:i${i}`,
      type: 'interrupt',
      sessionId: s.id,
      agent: s.agent,
      projectKey: t.projectKey,
      projectLabel: t.projectKey !== null && t.projectKey === s.projectKey ? s.project : null,
      turn: i,
      ts: t.ts,
      interrupt: t.interrupt!,
      humanTurn: human ? human.i : null,
      crossesGap,
      skippedInjected: skipped,
      gapSec: human ? gap(t.ts, human.ts) : null,
      interruptedCall: cut,
      pasted: human !== null && isPasted(human.text),
      receipt: {
        quote: human ? clip(human.text, QUOTE_LIMIT) : null,
        action: describeCall(cut),
        result: describeResult(cut),
      },
    });
  }
  return out;
}

/** Commands that change state count as a changed hypothesis between two runs. */
const STATE_CHANGING = new Set(['npm', 'bun', 'pnpm', 'yarn', 'pip', 'pip3', 'uv', 'cargo', 'git', 'rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'ln', 'brew', 'apt', 'make', 'export', 'sed', 'perl', 'tee', 'patch', 'apply_patch']);

function changesState(c: ToolCall, fp: string): boolean {
  if (c.kind === 'edit') return c.result?.status !== 'error' && c.result?.status !== 'rejected';
  if (c.kind !== 'shell' || !c.command) return false;
  const f = fingerprint(c.command);
  if (f === fp) return false;
  const prog = programOf(c.command);
  if (!prog || !STATE_CHANGING.has(prog)) return false;
  // `bun run build` / `npm test` are runs, not changes; installs and git writes are changes.
  if (['npm', 'bun', 'pnpm', 'yarn', 'cargo', 'make'].includes(prog)) return /\b(install|add|remove|i|update|upgrade|clean|ci|sync)\b/.test(f);
  if (prog === 'git') return /\bgit\s+(checkout|switch|reset|restore|stash|pull|merge|rebase|apply|cherry-pick|revert|commit)\b/.test(f);
  if (prog === 'sed' || prog === 'perl') return /\s-i/.test(f);
  return true;
}

/**
 * Type 2: the same command fingerprint failed at least twice with nothing changed in between.
 * Not a failure: exit 0, 'nomatch' (grep/rg/diff exit 1), 'unknown', interrupted or rejected runs.
 * An expected failing test (fail → edit → pass) and a normal edit loop (fail → edit → fail → edit → pass)
 * never contain two unchanged failures in a row, so they produce nothing.
 */
export function repeatedCommandEpisodes(s: Session): RepeatedCommandEpisode[] {
  const out: RepeatedCommandEpisode[] = [];
  const calls = allCalls(s).filter((c) => !(c.parentCallId === null && c.name === 'exec' && c.kind === 'other'));
  const turnOf = new Map<string, Turn>();
  for (const t of s.turns) for (const c of t.calls) turnOf.set(c.callId, t);
  // Per fingerprint: the current run of unchanged failures.
  const runs = new Map<string, ToolCall[]>();
  const done = new Set<string>();
  const flush = (fp: string, laterSuccess: boolean) => {
    const run = runs.get(fp);
    runs.delete(fp);
    if (!run || run.length < 2) return;
    const first = run[0]!;
    const anchor = run[1]!;
    const t = turnOf.get(anchor.callId);
    // The nearest genuine human message before the anchor, if any, is context; the receipt is the tool evidence.
    const pk = t ? t.projectKey : s.projectKey;
    out.push({
      id: `${s.id}:r${out.length}`,
      type: 'repeated-command',
      sessionId: s.id,
      agent: s.agent,
      projectKey: pk,
      projectLabel: pk !== null && pk === s.projectKey ? s.project : null,
      turn: t ? t.i : 0,
      ts: anchor.ts,
      fingerprint: fp,
      program: programOf(fp),
      prefix: commandPrefixOf(fp),
      failures: run.map((c) => c.callId),
      laterSuccess,
      receipt: { quote: null, action: describeCall(first), result: describeResult(anchor) },
    });
    done.add(fp);
  };
  for (const c of calls) {
    // Any state change breaks every open run except the one for this very command.
    if (c.kind === 'edit' || (c.kind === 'shell' && c.command)) {
      const fpC = c.command ? fingerprint(c.command) : '';
      for (const fp of [...runs.keys()]) if (fp !== fpC && changesState(c, fp)) flush(fp, false);
    }
    if (c.kind !== 'shell' || !c.command || !c.result) continue;
    const fp = fingerprint(c.command);
    const st = c.result.status;
    if (st === 'error') {
      const run = runs.get(fp) ?? [];
      const prev = run[run.length - 1];
      if (prev && prev.result && (gapBetween(s, prev.result.seq, c.seq) || c.seq <= prev.result.seq)) {
        // Across a source gap the runs cannot be joined. A run launched before the previous failure's
        // result arrived (concurrent launches) is not a retry made after seeing the error.
        if (gapBetween(s, prev.result.seq, c.seq)) flush(fp, false);
        if (c.seq <= prev.result.seq) continue;
      }
      const cur = runs.get(fp) ?? [];
      cur.push(c);
      runs.set(fp, cur);
    } else if (st === 'ok') {
      flush(fp, true);
    } else {
      // nomatch / unknown / interrupted / rejected: no signal; the run is neither extended nor broken.
    }
  }
  for (const fp of [...runs.keys()]) flush(fp, false);
  return out;
}

export function detectEpisodes(s: Session): Episode[] {
  return [...interruptEpisodes(s), ...repeatedCommandEpisodes(s)];
}

/** Mirror counts with denominators (spec §8). */
export interface MirrorCounts {
  sessions: { total: number; claude: number; codex: number; agentAuthored: number; partial: number };
  humanTurns: number;
  interrupts: number;
  /** Interrupts paired with a genuine human message, out of interrupts. */
  interruptPairs: number;
  repeatedCommand: { episodes: number; sessionsWith: number; shellCalls: number; failedShellCalls: number };
  calls: { total: number; withResult: number; orphanResults: number };
  injectedTurns: number;
  redactions: number;
  projects: string[];
  topTools: [string, number][];
}

export function mirror(sessions: Session[]): MirrorCounts {
  const m: MirrorCounts = {
    sessions: { total: sessions.length, claude: 0, codex: 0, agentAuthored: 0, partial: 0 },
    humanTurns: 0,
    interrupts: 0,
    interruptPairs: 0,
    repeatedCommand: { episodes: 0, sessionsWith: 0, shellCalls: 0, failedShellCalls: 0 },
    calls: { total: 0, withResult: 0, orphanResults: 0 },
    injectedTurns: 0,
    redactions: 0,
    projects: [],
    topTools: [],
  };
  const tools = new Map<string, number>();
  const projects = new Set<string>();
  for (const s of sessions) {
    m.sessions[s.agent]++;
    if (s.agentAuthored) m.sessions.agentAuthored++;
    if (s.partial) m.sessions.partial++;
    if (s.project) projects.add(s.project);
    m.calls.orphanResults += s.stats.orphanResults;
    for (const v of Object.values(s.stats.redactions)) m.redactions += v;
    for (const t of s.turns) {
      if (t.role === 'human') m.humanTurns++;
      if (t.role === 'injected') m.injectedTurns++;
      if (t.role === 'interrupt' && !s.agentAuthored) m.interrupts++;
      for (const c of t.calls) {
        m.calls.total++;
        if (c.result) m.calls.withResult++;
        tools.set(c.name, (tools.get(c.name) ?? 0) + 1);
        if (c.kind === 'shell') {
          m.repeatedCommand.shellCalls++;
          if (c.result?.status === 'error') m.repeatedCommand.failedShellCalls++;
        }
      }
    }
    const ie = interruptEpisodes(s);
    m.interruptPairs += ie.filter((e) => e.humanTurn !== null).length;
    const re = repeatedCommandEpisodes(s);
    m.repeatedCommand.episodes += re.length;
    if (re.length) m.repeatedCommand.sessionsWith++;
  }
  m.projects = [...projects].sort();
  m.topTools = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return m;
}
