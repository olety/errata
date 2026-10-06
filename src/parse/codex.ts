// Codex rollout parser: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Handles the Codex Desktop shape (code-mode `exec`, item_completed CommandExecution / FileChange,
// content_item_kinds) and the open-source CLI shape (function_call shell / exec_command, exec_command_end,
// apply_patch, event_msg user_message). Push one line at a time; call finish().

import type { ResultStatus, Session, ToolCall } from '../model';
import { TEXT_LIMITS, projectFromCwd, projectKeyOf } from '../model';
import { classifyUserText, codeModeCommands, finishSession, newStats, patchFiles, shellStatus, toolKindFor, TurnBuilder } from './common';
import type { ParseMeta } from './claude';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Content kinds that are a genuine human typing. Everything else in a user-role message is injected context. */
const HUMAN_KINDS = new Set(['user.text']);

export class CodexParser {
  private stats = newStats();
  private b = new TurnBuilder(this.stats);
  private s: Session;
  private lastLineBad = false;
  private sawMeta = false;
  /** The code-mode exec call whose output has not arrived yet; commands it runs become its children. */
  private openExec: string | null = null;
  private seq = 0;

  constructor(private meta: ParseMeta) {
    this.s = {
      id: `codex:${meta.file.replace(/\.jsonl$/, '')}`,
      nativeId: meta.file.replace(/\.jsonl$/, ''),
      projectKey: null,
      gaps: [],
      agent: 'codex',
      file: meta.file,
      startedAt: null,
      endedAt: null,
      cwd: null,
      gitBranch: null,
      project: null,
      client: null,
      source: null,
      agentAuthored: meta.agentAuthored ?? false,
      partial: meta.window === 'tail-window',
      partialReason: meta.window === 'tail-window' ? 'tail-window' : null,
      turns: [],
      stats: this.stats,
    };
  }

  oversized(): void {
    this.stats.lines++;
    this.stats.oversizedRows++;
    this.s.gaps.push({ afterSeq: this.stats.lines - 1, kind: 'oversized-row' });
  }

  tailGap(): void {
    this.s.gaps.push({ afterSeq: this.stats.lines, kind: 'tail-window' });
  }

  push(line: string): void {
    this.stats.lines++;
    this.b.seq = this.stats.lines;
    let o: unknown;
    try {
      o = JSON.parse(line);
      this.lastLineBad = false;
    } catch {
      this.stats.badLines++;
      this.lastLineBad = true;
      this.s.gaps.push({ afterSeq: this.stats.lines - 1, kind: 'bad-line' });
      return;
    }
    if (!isObj(o)) return;
    const ts = str(o.timestamp);
    const type = str(o.type);
    const p = isObj(o.payload) ? o.payload : null;
    if (!p) return;
    switch (type) {
      case 'session_meta':
        return this.sessionMeta(p, ts);
      case 'turn_context':
        this.setCwd(str(p.cwd));
        return;
      case 'response_item':
        return this.responseItem(o, p, ts);
      case 'event_msg':
        return this.eventMsg(p, ts);
      case 'compacted':
        // replacement_history repeats earlier messages; never re-parse it as turns.
        this.b.push('injected', ts, this.b.r(str(p.message) ?? '', 300), { injected: 'summary' });
        return;
      default:
        return;
    }
  }

  private setCwd(cwd: string | null): void {
    if (!cwd) return;
    this.b.projectKey = projectKeyOf(cwd);
    if (this.s.cwd) return;
    this.s.cwd = this.b.r(cwd, 400);
    this.s.project = projectFromCwd(this.s.cwd);
    this.s.projectKey = this.b.projectKey;
  }

  private sessionMeta(p: Json, ts: string | null): void {
    if (this.sawMeta) return; // forked threads carry a second session_meta for the parent; the first is this thread
    this.sawMeta = true;
    const id = str(p.id) ?? str(p.session_id);
    if (id) {
      this.s.nativeId = id;
      this.s.id = `codex:${id}`;
    }
    this.s.startedAt = str(p.timestamp) ?? ts;
    this.setCwd(str(p.cwd));
    this.s.client = str(p.originator);
    const src = p.source;
    this.s.source = typeof src === 'string' ? src : isObj(src) ? Object.keys(src)[0] ?? null : null;
    if (isObj(src) && 'subagent' in src) this.s.agentAuthored = true;
    if (str(p.agent_role) || str(p.agent_nickname)) this.s.agentAuthored = true;
    const git = isObj(p.git) ? p.git : null;
    const br = git ? str(git.branch) : null;
    if (br) this.s.gitBranch = this.b.r(br, 200);
  }

  private responseItem(o: Json, p: Json, ts: string | null): void {
    const t = str(p.type);
    if (t === 'message') return this.message(o, p, ts);
    if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call') return this.call(p, ts);
    if (t === 'function_call_output' || t === 'custom_tool_call_output') return this.output(p, ts);
    // reasoning (encrypted), agent_message (inter-agent), web_search_call: not stored
  }

  private message(o: Json, p: Json, ts: string | null): void {
    const role = str(p.role);
    const content = Array.isArray(p.content) ? p.content : [];
    if (role === 'assistant') {
      const text = content.map((c) => (isObj(c) ? str(c.text) ?? '' : '')).join('\n');
      if (text.trim()) this.b.appendAssistantText(ts, text);
      return;
    }
    if (role === 'developer' || role === 'system') {
      const text = content.map((c) => (isObj(c) ? str(c.text) ?? '' : '')).join('\n');
      this.b.push('injected', ts, this.b.r(text, 200), { injected: 'developer' });
      return;
    }
    if (role !== 'user') return;
    const md = isObj(p.internal_chat_message_metadata_passthrough) ? p.internal_chat_message_metadata_passthrough : null;
    const kinds = md && Array.isArray(md.content_item_kinds) ? (md.content_item_kinds as unknown[]) : null;
    const meta = isObj(o.metadata) ? o.metadata : null;
    const inherited = meta?.inherited_user_message === true;
    const kindsAligned = kinds !== null && kinds.length === content.length;
    content.forEach((c, i) => {
      if (!isObj(c)) return;
      const ctype = str(c.type);
      if (ctype === 'input_image') {
        this.b.push('injected', ts, '', { injected: 'image' });
        return;
      }
      const text = str(c.text) ?? '';
      if (inherited) {
        this.b.push('injected', ts, this.b.r(text, 300), { injected: 'inherited' });
        return;
      }
      let human: boolean;
      if (kindsAligned) {
        const k = str(kinds![i]);
        human = k !== null && HUMAN_KINDS.has(k);
        if (!human) {
          this.b.push('injected', ts, this.b.r(text, 300), { injected: 'context' });
          return;
        }
        // A user.text item can still carry a pasted continuation summary or app-injected wrappers
        // (measured: <image …>, <in-app-browser-context>); the same quarantine applies.
        const cls = classifyUserText(text);
        if (cls.role === 'injected') {
          this.b.push('injected', ts, this.b.r(text, 300), { injected: cls.injected });
          return;
        }
      } else {
        const cls = classifyUserText(text);
        if (cls.role !== 'human') {
          this.b.push('injected', ts, this.b.r(text, 300), { injected: cls.role === 'injected' ? cls.injected : 'tag' });
          return;
        }
      }
      if (this.s.agentAuthored) {
        this.b.push('injected', ts, this.b.r(text, 300), { injected: 'agent-task' });
        return;
      }
      this.b.push('human', ts, this.b.r(text));
    });
  }

  private call(p: Json, ts: string | null): void {
    const name = str(p.name) ?? (str(p.type) === 'local_shell_call' ? 'local_shell' : 'unknown');
    const callId = str(p.call_id) ?? str(p.id) ?? `c${this.seq++}`;
    const rawInput = str(p.input) ?? str(p.arguments) ?? (isObj(p.action) ? JSON.stringify(p.action) : '');
    let kind = toolKindFor(name);
    let command: string | null = null;
    let files: string[] = [];
    if (name === 'exec' && str(p.type) === 'custom_tool_call') {
      // Code-mode: JS that calls tools.exec_command(...). The commands arrive as item_completed CommandExecution.
      files = patchFiles(rawInput);
      kind = files.length > 0 ? 'edit' : 'other';
      // For display only: the commands the script names. The runs themselves arrive as CommandExecution items.
      const named = codeModeCommands(rawInput);
      if (named.length) command = named.join(' ; ');
      this.openExec = callId;
    } else if (name === 'apply_patch') {
      files = patchFiles(rawInput);
      kind = 'edit';
    } else if (kind === 'shell') {
      command = shellCommandFromArgs(rawInput, p);
      if (command && /\*\*\* Begin Patch/.test(command)) {
        files = patchFiles(command);
        kind = 'edit';
      }
    }
    this.b.addCall(ts, {
      callId,
      parentCallId: null,
      name,
      kind,
      command: command ? this.b.r(command, TEXT_LIMITS.input) : null,
      files: files.map((f) => this.b.r(f, 400)),
      input: this.b.r(rawInput, TEXT_LIMITS.input),
    });
  }

  private output(p: Json, ts: string | null): void {
    const callId = str(p.call_id);
    if (!callId) return;
    if (this.openExec === callId) this.openExec = null;
    const out = p.output;
    let text = '';
    if (typeof out === 'string') text = out;
    else if (Array.isArray(out)) text = out.map((c) => (isObj(c) ? str(c.text) ?? '' : '')).join('\n');
    else if (isObj(out)) text = str(out.content) ?? JSON.stringify(out);
    const call = this.b.calls.get(callId) ?? null;
    let exitCode: number | null = null;
    let status: ResultStatus = 'unknown';
    // CLI shell output: {"output": "...", "metadata": {"exit_code": N}} or "Exit code: N" / "Process exited with code N".
    if (text.startsWith('{')) {
      try {
        const j = JSON.parse(text) as Json;
        const md = isObj(j.metadata) ? j.metadata : null;
        exitCode = num(md?.exit_code);
        if (typeof j.output === 'string') text = j.output;
      } catch {
        /* not JSON */
      }
    }
    if (exitCode === null) {
      const m = /(?:^|\n)(?:Exit code:|Process exited with code) (\d+)/.exec(text);
      if (m) exitCode = Number(m[1]);
    }
    if (call?.name === 'exec' && /^Script completed/.test(text)) status = 'ok';
    else if (call?.name === 'exec' && /^Script failed/.test(text)) status = 'error';
    else if (/^aborted by user|^Turn aborted|interrupted/i.test(text.slice(0, 40))) status = 'interrupted';
    if (call && (call.kind === 'shell' || exitCode !== null)) status = shellStatus(call.command, exitCode, status);
    this.b.result(callId, { ts, status, exitCode, text: this.b.r(text, TEXT_LIMITS.result) });
  }

  private eventMsg(p: Json, ts: string | null): void {
    const t = str(p.type);
    if (t === 'turn_aborted') {
      const reason = str(p.reason);
      if (reason === null || reason === 'interrupted') this.b.push('interrupt', ts, '', { interrupt: 'turn_aborted' });
      return;
    }
    if (t === 'item_completed' && isObj(p.item)) return this.item(p.item, ts);
    if (t === 'exec_command_end') {
      const callId = str(p.call_id);
      const call = callId ? this.b.calls.get(callId) : undefined;
      if (call) {
        const exitCode = num(p.exit_code);
        const text = str(p.aggregated_output) ?? str(p.stdout) ?? '';
        // The event carries the authoritative exit code; it wins over a text-parsed one.
        this.b.result(call.callId, { ts, status: shellStatus(call.command, exitCode, 'unknown'), exitCode, text: this.b.r(text, TEXT_LIMITS.result) }, { override: true });
      }
      return;
    }
    if (t === 'patch_apply_end') {
      const callId = str(p.call_id);
      const call = callId ? this.b.calls.get(callId) : undefined;
      if (call && !call.result) this.b.result(call.callId, { ts, status: p.success === false ? 'error' : 'ok', exitCode: null, text: '' });
    }
    // user_message duplicates the response_item user message; token_count, task_* etc. are not stored.
  }

  private item(it: Json, ts: string | null): void {
    const t = str(it.type);
    const id = str(it.id) ?? `i${this.seq++}`;
    if (t === 'CommandExecution') {
      const cmd = commandFromArray(it.command);
      const exitCode = num(it.exit_code);
      const st = str(it.status);
      const fallback: ResultStatus = st === 'declined' ? 'rejected' : st === 'failed' ? 'error' : 'unknown';
      const text = str(it.aggregated_output) ?? str(it.stdout) ?? '';
      const command = cmd ? this.b.r(cmd, TEXT_LIMITS.input) : null;
      const res = { ts, status: shellStatus(cmd, exitCode, fallback), exitCode, text: this.b.r(text, TEXT_LIMITS.result) };
      // A direct (non code-mode) shell call still waiting for its result: this item mirrors it.
      if (!this.openExec) {
        const mirror = [...this.b.calls.values()].reverse().find((c) => c.kind === 'shell' && !c.result && c.parentCallId === null && c.command === command);
        if (mirror) {
          this.b.result(mirror.callId, res);
          return;
        }
      }
      let kind: ToolCall['kind'] = 'shell';
      let files: string[] = [];
      if (cmd && /\*\*\* Begin Patch/.test(cmd)) {
        files = patchFiles(cmd).map((f) => this.b.r(f, 400));
        kind = 'edit';
      }
      this.b.addCall(ts, {
        callId: id,
        parentCallId: this.openExec,
        name: 'exec_command',
        kind,
        command,
        files,
        input: command ?? '',
        result: res,
      });
      return;
    }
    if (t === 'FileChange') {
      const changes = isObj(it.changes) ? Object.keys(it.changes) : [];
      const st = str(it.status);
      this.b.addCall(ts, {
        callId: id,
        parentCallId: this.openExec,
        name: 'file_change',
        kind: 'edit',
        command: null,
        files: changes.map((f) => this.b.r(f, 400)),
        input: '',
        result: { ts, status: st === 'completed' ? 'ok' : st === 'failed' ? 'error' : st === 'declined' ? 'rejected' : 'unknown', exitCode: null, text: '' },
      });
      return;
    }
    if (t === 'McpToolCall') {
      const st = str(it.status);
      this.b.addCall(ts, {
        callId: id,
        parentCallId: this.openExec,
        name: `mcp:${str(it.server) ?? '?'}.${str(it.tool) ?? '?'}`,
        kind: 'other',
        command: null,
        files: [],
        input: '',
        result: { ts, status: st === 'completed' ? 'ok' : st === 'failed' ? 'error' : 'unknown', exitCode: null, text: '' },
      });
    }
  }

  finish(): Session {
    if (this.lastLineBad && !this.s.partial) {
      this.s.partial = true;
      this.s.partialReason = 'truncated-line';
    }
    this.s.turns = this.b.turns;
    return finishSession(this.s);
  }
}

/** ["/bin/zsh", "-lc", "cmd"] → "cmd"; ["git", "status"] → "git status". */
export function commandFromArray(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  const a = v.filter((x): x is string => typeof x === 'string');
  if (a.length >= 3 && /(?:^|\/)(?:ba|z|fi|da)?sh$/.test(a[0]!) && /^-\w*c$/.test(a[1]!)) return a.slice(2).join(' ');
  return a.join(' ');
}

function shellCommandFromArgs(raw: string, p: Json): string | null {
  if (isObj(p.action)) return commandFromArray((p.action as Json).command);
  try {
    const j = JSON.parse(raw) as Json;
    if (typeof j.cmd === 'string') return j.cmd;
    return commandFromArray(j.command);
  } catch {
    return raw || null;
  }
}
