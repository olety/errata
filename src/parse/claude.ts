// Claude Code session parser: ~/.claude/projects/<project>/<session>.jsonl (and subagents/**/agent-*.jsonl).
// Push one line at a time; call finish() for the Session. Raw rows never leave this module.

import type { ResultStatus, Session, ToolCall } from '../model';
import { TEXT_LIMITS, projectFromCwd, projectKeyOf } from '../model';
import { classifyUserText, finishSession, newStats, shellStatus, toolKindFor, TurnBuilder } from './common';

export interface ParseMeta {
  /** File name only. */
  file: string;
  /** Set by the importer from the path (…/subagents/…). */
  agentAuthored?: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class ClaudeParser {
  private stats = newStats();
  private b = new TurnBuilder(this.stats);
  private s: Session;
  private lastLineBad = false;
  private sawSid = false;

  constructor(private meta: ParseMeta) {
    this.s = {
      id: `claude:${meta.file.replace(/\.jsonl$/, '')}`,
      nativeId: meta.file.replace(/\.jsonl$/, ''),
      projectKey: null,
      gaps: [],
      agent: 'claude',
      file: meta.file,
      startedAt: null,
      endedAt: null,
      cwd: null,
      gitBranch: null,
      project: null,
      client: null,
      source: null,
      agentAuthored: meta.agentAuthored ?? false,
      partial: false,
      partialReason: null,
      turns: [],
      stats: this.stats,
    };
  }

  oversized(): void {
    this.stats.lines++;
    this.stats.oversizedRows++;
    this.s.gaps.push({ afterSeq: this.stats.lines - 1, kind: 'oversized-row' });
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
    const type = str(o.type);
    if (type !== 'user' && type !== 'assistant') return;
    const ts = str(o.timestamp);
    this.header(o, ts);
    if (o.isSidechain === true) this.s.agentAuthored = true;
    const msg = isObj(o.message) ? o.message : null;
    if (!msg) return;
    if (type === 'assistant') this.assistantRow(msg, ts);
    else this.userRow(o, msg, ts);
  }

  private header(o: Json, ts: string | null): void {
    const s = this.s;
    if (!s.startedAt && ts) s.startedAt = ts;
    const sid = str(o.sessionId);
    if (sid && !this.sawSid) {
      this.sawSid = true;
      s.nativeId = sid;
      // Subagent files share the parent's sessionId; the file stem keeps their canonical id unique.
      s.id = this.meta.agentAuthored ? `claude:${sid}/${this.meta.file.replace(/\.jsonl$/, '')}` : `claude:${sid}`;
    }
    const cwd = str(o.cwd);
    if (cwd) {
      this.b.projectKey = projectKeyOf(cwd);
      if (!s.cwd) {
        s.cwd = this.b.r(cwd, 400);
        s.project = projectFromCwd(s.cwd);
        s.projectKey = this.b.projectKey;
      }
    }
    if (!s.gitBranch) {
      const br = str(o.gitBranch);
      if (br && br !== 'HEAD') s.gitBranch = this.b.r(br, 200);
    }
    if (!s.client) s.client = str(o.entrypoint);
  }

  private assistantRow(msg: Json, ts: string | null): void {
    const content = msg.content;
    if (typeof content === 'string') {
      this.b.appendAssistantText(ts, content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const blk of content) {
      if (!isObj(blk)) continue;
      if (blk.type === 'text') this.b.appendAssistantText(ts, str(blk.text) ?? '');
      else if (blk.type === 'tool_use') this.toolUse(blk, ts);
      // thinking blocks are never stored
    }
  }

  private toolUse(blk: Json, ts: string | null): void {
    const id = str(blk.id);
    const name = str(blk.name) ?? 'unknown';
    if (!id) return;
    const input = isObj(blk.input) ? blk.input : {};
    const kind = toolKindFor(name);
    let command: string | null = null;
    const files: string[] = [];
    if (kind === 'shell') command = this.b.r(str(input.command) ?? '', TEXT_LIMITS.input) || null;
    const fp = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
    if (fp && (kind === 'edit' || kind === 'read')) files.push(this.b.r(fp, 400));
    let inputSummary: string;
    try {
      inputSummary = JSON.stringify(input);
    } catch {
      inputSummary = '';
    }
    this.b.addCall(ts, { callId: id, parentCallId: null, name, kind, command, files, input: this.b.r(inputSummary, TEXT_LIMITS.input) });
  }

  private userRow(o: Json, msg: Json, ts: string | null): void {
    const content = msg.content;
    if (o.isCompactSummary === true) {
      this.b.push('injected', ts, this.b.r(flatten(content), 300), { injected: 'summary' });
      return;
    }
    if (o.isMeta === true) {
      this.b.push('injected', ts, this.b.r(flatten(content), 300), { injected: 'meta' });
      return;
    }
    if (typeof content === 'string') {
      this.userText(content, ts);
      return;
    }
    if (!Array.isArray(content)) return;
    let sawText = false;
    let sawImage = false;
    for (const blk of content) {
      if (!isObj(blk)) continue;
      if (blk.type === 'tool_result') this.toolResult(o, blk, ts);
      else if (blk.type === 'text') {
        sawText = true;
        this.userText(str(blk.text) ?? '', ts);
      } else if (blk.type === 'image') sawImage = true;
    }
    if (sawImage && !sawText) this.b.push('injected', ts, '', { injected: 'image' });
  }

  private userText(text: string, ts: string | null): void {
    const c = classifyUserText(text);
    if (c.role === 'interrupt') {
      this.b.push('interrupt', ts, '', { interrupt: c.interrupt });
      return;
    }
    if (c.role === 'injected') {
      this.b.push('injected', ts, this.b.r(text, 300), { injected: c.injected });
      return;
    }
    if (this.s.agentAuthored) {
      this.b.push('injected', ts, this.b.r(text, 300), { injected: 'agent-task' });
      return;
    }
    this.b.push('human', ts, this.b.r(text));
  }

  private toolResult(o: Json, blk: Json, ts: string | null): void {
    const id = str(blk.tool_use_id);
    if (!id) return;
    const text = flatten(blk.content);
    const tur = o.toolUseResult;
    const call = this.b.calls.get(id) ?? null;
    let status: ResultStatus;
    let exitCode: number | null = null;
    const m = /^(?:Error: )?Exit code (\d+)/.exec(text);
    if (m) exitCode = Number(m[1]);
    if ((typeof tur === 'string' && /rejected/i.test(tur)) || /^The user doesn't want to proceed/.test(text)) status = 'rejected';
    else if ((isObj(tur) && tur.interrupted === true) || text.startsWith('[Request interrupted by user')) status = 'interrupted';
    else if (blk.is_error === true) status = 'error';
    else status = 'ok';
    if (call?.kind === 'shell') {
      if (status === 'ok' && exitCode === null) exitCode = 0;
      if (status === 'error' || status === 'ok') status = shellStatus(call.command, exitCode, status);
    }
    this.b.result(id, { ts, status, exitCode, text: this.b.r(text, TEXT_LIMITS.result) });
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

/** Text of a string or a content-block list (text blocks only). */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const b of content) if (isObj(b) && b.type === 'text' && typeof b.text === 'string') out.push(b.text);
  return out.join('\n');
}

export type { ToolCall };
