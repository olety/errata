// The normalized session model. Both parsers (Claude Code, Codex) produce exactly this.
// Every string in here has already passed through the redactor (src/redact.ts).
// Nothing outside the parsers ever sees a raw log line.

export type Agent = 'claude' | 'codex';

/** Why a user-role text is not a genuine human message. Quarantined text never becomes a quote or a card. */
export type InjectedKind =
  | 'summary' // "This session is being continued…" / Claude isCompactSummary / Codex compacted history
  | 'cross-session' // "Another Claude session…"
  | 'image' // "[Image…" or an image-only user turn
  | 'tag' // text that starts with "<" (system-reminder, task-notification, command wrappers, environment_context)
  | 'meta' // Claude isMeta rows
  | 'developer' // Codex developer-role messages (injected instructions)
  | 'context' // Codex user-role items whose content kind is not user.text (AGENTS.md, environment, plugins, pages)
  | 'inherited' // Codex inherited_user_message copies in forked / subagent threads
  | 'agent-task'; // user-role text inside an agent-authored thread (Claude sidechain, Codex source.subagent)

export type InterruptKind =
  | 'user' // Claude "[Request interrupted by user]"
  | 'tool_use' // Claude "[Request interrupted by user for tool use]"
  | 'turn_aborted'; // Codex event_msg turn_aborted (reason interrupted)

export type TurnRole = 'human' | 'assistant' | 'injected' | 'interrupt';

export interface Turn {
  /** Position in Session.turns. */
  i: number;
  /** Source position (1-based line number in the read window). Orders turns, calls and results; never crosses a gap unnoticed. */
  seq: number;
  /** Opaque key of the cwd in force when this turn was logged (see projectKeyOf). Null when unknown. */
  projectKey: string | null;
  role: TurnRole;
  /** ISO timestamp from the log line, null when the line had none. */
  ts: string | null;
  /** Redacted text. Empty for interrupt turns and tool-only assistant turns. */
  text: string;
  injected?: InjectedKind;
  interrupt?: InterruptKind;
  /** Tool calls the assistant made in this turn, in call order. Only assistant turns carry calls. */
  calls: ToolCall[];
}

export type ToolKind = 'shell' | 'edit' | 'read' | 'search' | 'agent' | 'other';

/**
 * Result status. 'nomatch' = a nonzero exit that means "nothing found" (grep, rg, diff, test).
 * 'unknown' = the result exists but carries no reliable success signal. Unknown is never failure.
 */
export type ResultStatus = 'ok' | 'error' | 'nomatch' | 'interrupted' | 'rejected' | 'unknown';

export interface ToolResult {
  /** Source position of the row that carried the result. */
  seq: number;
  ts: string | null;
  status: ResultStatus;
  exitCode: number | null;
  /** Redacted head of the output, bounded (see TEXT_LIMITS). */
  text: string;
}

export interface ToolCall {
  /** Log-native call id (Claude tool_use.id, Codex call_id or item id). Unique within the session. */
  callId: string;
  /** Source position of the row that carried the call. */
  seq: number;
  /** Codex code-mode: the exec call this command ran inside. Null otherwise. */
  parentCallId: string | null;
  name: string;
  kind: ToolKind;
  ts: string | null;
  /** Shell commands only: the redacted command line, arguments preserved. */
  command: string | null;
  /** Files this call reliably edits (edit kind) or reads. Redacted paths. */
  files: string[];
  /** Redacted, bounded summary of the raw input. */
  input: string;
  /** Null until the paired result arrives; stays null if it never does (never guessed). */
  result: ToolResult | null;
}

export interface RedactionCounts {
  [kind: string]: number;
}

export interface SessionStats {
  lines: number;
  badLines: number;
  /** Rows dropped because they exceeded MAX_LINE_BYTES. */
  oversizedRows: number;
  /** Results whose call id was never seen (e.g. the call fell before a tail window). */
  orphanResults: number;
  redactions: RedactionCounts;
}

/** A discontinuity in the source: pairing, run counting and durations never cross one. */
export interface Gap {
  /** The gap sits right after this source position (0 = before the first line). */
  afterSeq: number;
  kind: 'bad-line' | 'oversized-row' | 'tail-window';
}

export interface Session {
  /** Canonical id, unique across the import: "<agent>:<native id>[/<subagent file>]". */
  id: string;
  /** The log's own session / thread id (Claude subagent files share their parent's). */
  nativeId: string;
  agent: Agent;
  /** File name only, never a full path. */
  file: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Redacted cwd as logged. */
  cwd: string | null;
  gitBranch: string | null;
  /** Scope chip for display: last path segment of cwd, null when absent or a bare home dir. Not an identity. */
  project: string | null;
  /** Opaque project identity: hash of the full first cwd, computed before redaction. Null when no project. */
  projectKey: string | null;
  /** Claude entrypoint / Codex originator (e.g. "Codex Desktop", "codex_cli_rs"). */
  client: string | null;
  /** Codex session_meta.source as logged ("vscode", "cli", "exec", or "subagent"); null for Claude Code.
   *  Never classify the client from this alone: Codex Desktop logs source "vscode". */
  source: string | null;
  /** Agent-authored thread (Claude subagent file, Codex subagent thread). Its user turns are not human. */
  agentAuthored: boolean;
  /** True when the session was read through a tail window or has a truncated last line. */
  partial: boolean;
  partialReason: 'tail-window' | 'truncated-line' | 'bad-lines' | null;
  gaps: Gap[];
  turns: Turn[];
  stats: SessionStats;
}

export const TEXT_LIMITS = {
  /** Human and assistant message text kept per turn. */
  message: 4000,
  /** Tool input summary. */
  input: 1200,
  /** Tool result head. */
  result: 1500,
} as const;

/** Rows above this are dropped and counted, never parsed. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Sessions above this are read as header line + complete-line tail window. */
export const OVERSIZED_SESSION_BYTES = 24 * 1024 * 1024;
export const TAIL_WINDOW_BYTES = 8 * 1024 * 1024;
/** Total import budget across all selected files. */
export const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

/** All calls in a session, in order. */
export function allCalls(s: Session): ToolCall[] {
  const out: ToolCall[] = [];
  for (const t of s.turns) for (const c of t.calls) out.push(c);
  return out;
}

/** Derive the scope chip from a cwd. Home directories and filesystem roots give no chip. */
export function projectFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return null;
  // A user's home directory (home/<u>, the macOS home root, a Windows profile) is not a project.
  if (parts.length <= 2 && /^(home|Users)$/i.test(parts[0] ?? '')) return null;
  if (parts.length === 1 && /^[A-Za-z]:$/.test(parts[0] ?? '')) return null;
  if (parts.length <= 3 && /^[A-Za-z]:$/.test(parts[0] ?? '') && /^Users$/i.test(parts[1] ?? '')) return null;
  const last = parts[parts.length - 1]!;
  if (last.startsWith('[redacted')) return null;
  return last;
}

/** Opaque project identity from a raw cwd: FNV-1a 32-bit hex of the normalized path. Null when the cwd is no project. */
export function projectKeyOf(rawCwd: string | null | undefined): string | null {
  if (!rawCwd || projectFromCwd(rawCwd) === null) return null;
  const norm = rawCwd.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'p' + h.toString(16).padStart(8, '0');
}

/** True when a gap lies between two source positions (a < b). */
export function gapBetween(s: Session, a: number, b: number): boolean {
  return s.gaps.some((g) => g.afterSeq >= a && g.afterSeq < b);
}
