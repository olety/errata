// Helpers shared by both parsers.

import type { InjectedKind, InterruptKind, ResultStatus, Session, SessionStats, ToolCall, ToolKind, ToolResult, Turn } from '../model';
import { TEXT_LIMITS } from '../model';
import { redactBounded } from '../redact';

export type UserTextClass =
  | { role: 'human' }
  | { role: 'interrupt'; interrupt: InterruptKind }
  | { role: 'injected'; injected: InjectedKind };

/** Classify Claude-style user text. Quarantined openers never become human turns. */
export function classifyUserText(raw: string): UserTextClass {
  const t = raw.replace(/^\s+/, '');
  if (t.startsWith('[Request interrupted by user for tool use]')) return { role: 'interrupt', interrupt: 'tool_use' };
  if (t.startsWith('[Request interrupted by user')) return { role: 'interrupt', interrupt: 'user' };
  if (t.startsWith('This session is being continued')) return { role: 'injected', injected: 'summary' };
  if (t.startsWith('Another Claude session')) return { role: 'injected', injected: 'cross-session' };
  if (t.startsWith('[Image')) return { role: 'injected', injected: 'image' };
  if (t.startsWith('<')) return { role: 'injected', injected: 'tag' };
  if (t.startsWith('# AGENTS.md instructions')) return { role: 'injected', injected: 'context' };
  if (t === '') return { role: 'injected', injected: 'tag' };
  return { role: 'human' };
}

/** Programs whose exit 1 means "nothing found / differs", not failure. */
const NOMATCH_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'diff', 'cmp', 'test', '[', 'which', 'pgrep', 'find']);

/** The program a command line runs, skipping env assignments, sudo, cd-prefixes and common wrappers. */
export function programOf(command: string): string | null {
  const segs = command.split(/&&|;|\|\|/).map((s) => s.trim()).filter(Boolean);
  // Use the last segment that is not a bare `cd`.
  const seg = [...segs].reverse().find((s) => !/^cd\s/.test(s)) ?? segs[0] ?? '';
  const words = seg.split(/\s+/).filter(Boolean);
  const i = skipWrappers(words);
  const w = words[i];
  if (!w) return null;
  return w.replace(/^.*\//, '');
}

/** Command wrappers that run another command: the wrapped command is what matters. */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'exec', 'command', 'rtk']);

function skipWrappers(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) {
      i++;
      // `rtk proxy <cmd>` and `rtk <cmd>` both wrap <cmd>.
      if (w === 'rtk' && words[i] === 'proxy') i++;
      continue;
    }
    break;
  }
  return i;
}

/** The first two words of the effective command ("bun test", "git push"), used as a card trigger prefix. */
export function commandPrefixOf(fingerprint: string): string {
  const all = fingerprint.split(' ');
  const words = all.slice(skipWrappers(all));
  const sub = (w: string | undefined) => !!w && /^[a-z][a-z0-9:._-]*$/.test(w);
  if (!sub(words[1])) return words[0] ?? '';
  // Runner verbs take one more word: "bun run build", "npm run lint", "uv run pytest".
  if (['run', 'exec', 'x', 'dlx'].includes(words[1]!) && sub(words[2])) return words.slice(0, 3).join(' ');
  return `${words[0]} ${words[1]}`;
}

/** Shell commands named inside a Codex code-mode exec script: tools.exec_command({cmd: "..."}). */
export function codeModeCommands(js: string): string[] {
  const out: string[] = [];
  const re = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g;
  for (let m = re.exec(js); m; m = re.exec(js)) {
    try {
      out.push(JSON.parse(m[1]!) as string);
    } catch {
      /* not a plain string literal */
    }
  }
  return out;
}

/** Normalized command fingerprint: whitespace collapsed, leading `cd X &&` dropped, arguments preserved. */
export function fingerprint(command: string): string {
  let s = command.replace(/\s+/g, ' ').trim();
  for (;;) {
    const m = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s;
}

/** Status for a shell result with a known exit code. */
export function shellStatus(command: string | null, exitCode: number | null, fallback: ResultStatus): ResultStatus {
  if (exitCode === null) return fallback;
  if (exitCode === 0) return 'ok';
  if (exitCode === 130 || exitCode === 143) return 'interrupted';
  const prog = command ? programOf(command) : null;
  if (exitCode === 1 && prog && NOMATCH_PROGRAMS.has(prog)) return 'nomatch';
  return 'error';
}

/** File paths named in an apply_patch body. */
export function patchFiles(text: string): string[] {
  const out: string[] = [];
  const re = /\*\*\* (?:Update|Add|Delete) File: ([^\n\r"\\]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const p = m[1]!.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function newStats(): SessionStats {
  return { lines: 0, badLines: 0, oversizedRows: 0, orphanResults: 0, redactions: {} };
}

/** Builds Session.turns with assistant-turn merging and call pairing. Shared by both parsers. */
export class TurnBuilder {
  turns: Turn[] = [];
  calls = new Map<string, ToolCall>();
  /** Source position of the row being parsed; set by the parser before each row. */
  seq = 0;
  /** Project key of the cwd in force; set by the parser when a row carries a cwd. */
  projectKey: string | null = null;
  constructor(private stats: SessionStats) {}

  r(text: string | null | undefined, limit: number = TEXT_LIMITS.message): string {
    return redactBounded(text ?? '', limit, this.stats.redactions);
  }

  push(role: Turn['role'], ts: string | null, text: string, extra: Partial<Turn> = {}): Turn {
    const t: Turn = { i: this.turns.length, seq: this.seq, projectKey: this.projectKey, role, ts, text, calls: [], ...extra };
    this.turns.push(t);
    return t;
  }

  /** The open assistant turn, creating one when the last turn is not an assistant turn. */
  assistant(ts: string | null): Turn {
    const last = this.turns[this.turns.length - 1];
    if (last && last.role === 'assistant') return last;
    return this.push('assistant', ts, '');
  }

  appendAssistantText(ts: string | null, text: string): void {
    const t = this.assistant(ts);
    const add = this.r(text);
    if (!add) return;
    t.text = t.text ? (t.text + '\n' + add).slice(0, TEXT_LIMITS.message + 1) : add;
  }

  addCall(ts: string | null, c: Omit<ToolCall, 'ts' | 'result' | 'seq'> & { result?: Omit<ToolResult, 'seq'> | null }): ToolCall {
    const { result, ...rest } = c;
    const call: ToolCall = { ts, seq: this.seq, ...rest, result: result ? { ...result, seq: this.seq } : null };
    // A duplicate id (e.g. a forked thread replaying history) keeps the first call.
    if (this.calls.has(call.callId)) return this.calls.get(call.callId)!;
    this.assistant(ts).calls.push(call);
    this.calls.set(call.callId, call);
    return call;
  }

  /** Attach a result to its call. Results whose call is unknown are counted, never bridged. */
  result(callId: string, res: Omit<ToolResult, 'seq'>, opts: { override?: boolean } = {}): ToolCall | null {
    const c = this.calls.get(callId);
    if (!c) {
      this.stats.orphanResults++;
      return null;
    }
    if (!c.result || opts.override) c.result = { ...res, seq: this.seq };
    return c;
  }
}

export function toolKindFor(name: string): ToolKind {
  const n = name.toLowerCase();
  if (['bash', 'shell', 'exec_command', 'local_shell', 'container.exec', 'unified_exec'].includes(n)) return 'shell';
  if (['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch'].includes(n)) return 'edit';
  if (['read', 'view_image', 'notebookread'].includes(n)) return 'read';
  if (['grep', 'glob', 'ls', 'websearch', 'webfetch'].includes(n)) return 'search';
  if (['agent', 'task', 'sendmessage', 'send_message', 'spawn_agent', 'wait', 'wait_agent', 'followup_task', 'list_agents', 'interrupt_agent'].includes(n)) return 'agent';
  return 'other';
}

export function finishSession(s: Session): Session {
  const firstTs = s.turns.find((t) => t.ts)?.ts ?? s.startedAt;
  const lastTs = [...s.turns].reverse().find((t) => t.ts)?.ts ?? null;
  s.startedAt = s.startedAt ?? firstTs ?? null;
  s.endedAt = lastTs ?? s.startedAt;
  return s;
}
