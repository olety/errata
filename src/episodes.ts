// Deterministic episode detection (spec §2), per session. Type 1 interrupt → next genuine human message;
// type 2 repeated unsuccessful command (after the noise filter); type 3 same-file edit sequence (a candidate);
// type 4 genuine directive candidates (repeated only once clustered across sessions, see ./rooms.ts);
// type 5 the narrow workflow occurrence (verified only in two or more sessions, see ./rooms.ts).
// An episode is a candidate. Nothing here declares a problem: every case starts 'unreviewed'.

import type { Agent, Session, ToolCall, Turn } from './model';
import { allCalls, gapBetween } from './model';
import { commandPrefixOf, fingerprint, programOf } from './parse/common';
import { isFocusedTest, isGenuineFailure, isTestCommand, isTestPath } from './noise';

export const QUOTE_LIMIT = 200;

export interface Receipt {
  /** The human's words (≤200 chars), or null → "Tool evidence only". */
  quote: string | null;
  /** The adjacent action: tool name + command/files, already redacted. */
  action: string | null;
  /** The adjacent result: status + exit code + redacted head. */
  result: string | null;
  /** What happened next, when it matters (the change that ended a run of failures). */
  then?: string | null;
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
  /** The reply reads as a change of plan ("actually, do X first") with no boundary words: a discovery aid. */
  pivotHint: boolean;
  /** What the agent did next about the cut-off action (the next run of the same program, or the first call). */
  followUp: ToolCall | null;
  /** The file the cut-off edit touched, relative to the session cwd. */
  cutPath: string | null;
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
  /** The state-changing call that ended the run of unchanged failures (e.g. an install), when there was one. */
  breaker: string | null;
}

export interface EditSequenceEpisode extends EpisodeBase {
  type: 'edit-sequence';
  /** The file as logged (redacted) and relative to the session cwd when it lies inside it. */
  file: string;
  /** Call ids of the distinct edits, in order (Codex FileChange items deduped against their exec patch). */
  edits: string[];
  /** An interrupt landed on an edit of this file: the candidate is promoted to a rewrite problem candidate. */
  promoted: boolean;
  /** The interrupt episode that promoted it (its id), so a room does not count the same stop twice. */
  corroboratedBy: string | null;
  /** A negation-bearing human message within ~90 s of an edit to this file: a discovery aid only, never a verdict. */
  negationNearEdit: boolean;
  /** A human approval followed the last edit ("nice, ship it"). */
  approvedAfter: boolean;
  /** Edits to a test file inside the sequence followed by a passing test: honest work, shown as context. */
  greenAfter: boolean;
}

export interface DirectiveEpisode extends EpisodeBase {
  type: 'directive';
  /** The genuine human text, ≤200 chars. */
  text: string;
  /** Exact-normalised form (lowercase, punctuation folded). */
  norm: string;
  /** Content tokens for near-duplicate matching. */
  tokens: string[];
  /** Turn index of the human message (also `turn`). */
  humanTurn: number;
  /** The message answered an interrupt (it is also the human side of an interrupt episode). */
  afterInterrupt: boolean;
}

export const WORKFLOW_VERIFY = 'focused-test>diff-review>report';

export interface WorkflowEpisode extends EpisodeBase {
  type: 'workflow';
  workflowKey: typeof WORKFLOW_VERIFY;
  /** The focused test command that passed observably, the diff commands, and the report excerpt. */
  test: string;
  testProgram: string | null;
  passEvidence: string;
  diffs: string[];
  report: string;
  callIds: string[];
}

export type Episode = InterruptEpisode | RepeatedCommandEpisode | EditSequenceEpisode | DirectiveEpisode | WorkflowEpisode;

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
  // For a failure, the most telling line is the last error line (a traceback ends with it), else the head.
  let body = c.result.text;
  if (c.result.status === 'error') {
    const errs = body.split('\n').filter((l) => /^\s*(?:[\w.]*(?:Error|Exception)\b|error\b|E\s{2,})/.test(l));
    if (errs.length) body = errs[errs.length - 1]!;
  }
  const head = body ? ` — ${clip(body, 140)}` : '';
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

/** Boundary and directive words. Their presence means the reply states a line, not just a new plan. */
export const DIRECTIVE_WORDS = /\b(?:never|don'?t|dont|do not|not|no|only|stop|avoid|without|leave|keep|instead|always|must|make sure|please use|use|prefer)\b/i;
const PIVOT_OPENERS = /^\s*(?:actually|wait|hmm+|oh|ok(?:ay)?,? (?:actually|instead)|on second thought|change of plan|let'?s|how about|first,?|before that)\b/i;
const BOUNDARY_WORDS = /\b(?:never|don'?t|dont|do not|not|no|only|stop|avoid|without|leave|instead of)\b/i;

/** A change of plan with no boundary words: "actually, do the changelog entry first, then the test". */
export function isPivotText(text: string): boolean {
  return PIVOT_OPENERS.test(text) && !BOUNDARY_WORDS.test(text);
}

/**
 * What the agent did next about the cut-off action: the next run of the same program when the cut-off call was a
 * command (a patch may come first), else the first call. Stops at the next human message or interrupt.
 */
function nextRelatedCall(turns: Turn[], from: number, cut: ToolCall | null): ToolCall | null {
  const prog = cut?.command ? programOf(fingerprint(cut.command)) : null;
  let first: ToolCall | null = null;
  for (let j = from + 1; j < turns.length; j++) {
    const u = turns[j]!;
    if (u.role === 'human' || u.role === 'interrupt') break;
    if (u.role !== 'assistant') continue;
    for (const c of u.calls) {
      first = first ?? c;
      if (!prog) return first;
      if (c.kind === 'shell' && c.command && programOf(fingerprint(c.command)) === prog) return c;
    }
  }
  return prog ? null : first;
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
      pivotHint: human !== null && isPivotText(human.text),
      followUp: human ? nextRelatedCall(turns, human.i, cut) : null,
      cutPath: cut && cut.kind === 'edit' && cut.files[0] ? relPath(cut.files[0], s.cwd) : null,
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
  const flush = (fp: string, laterSuccess: boolean, breaker: ToolCall | null = null) => {
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
      breaker: breaker?.command ? fingerprint(breaker.command) : breaker ? describeCall(breaker) : null,
      receipt: { quote: null, action: describeCall(first), result: describeResult(anchor), then: breaker ? describeCall(breaker) : null },
    });
    done.add(fp);
  };
  for (const c of calls) {
    // Any state change breaks every open run except the one for this very command.
    if (c.kind === 'edit' || (c.kind === 'shell' && c.command)) {
      const fpC = c.command ? fingerprint(c.command) : '';
      for (const fp of [...runs.keys()]) if (fp !== fpC && changesState(c, fp)) flush(fp, false, c);
    }
    if (c.kind !== 'shell' || !c.command || !c.result) continue;
    const fp = fingerprint(c.command);
    const st = c.result.status;
    if (st === 'error' && !isGenuineFailure(c)) continue; // a named negative: neither extends nor breaks a run
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

// ------------------------------------------------------------------ type 3: same-file edit sequence

/** Path relative to the session cwd when it lies inside it; else as logged. */
export function relPath(file: string, cwd: string | null): string {
  if (cwd) {
    const base = cwd.replace(/[\\/]+$/, '') + '/';
    if (file.startsWith(base)) return file.slice(base.length);
  }
  return file;
}

function editOk(c: ToolCall): boolean {
  const st = c.result?.status;
  return c.kind === 'edit' && !!c.result && st !== 'error' && st !== 'rejected' && st !== 'interrupted';
}

const NEGATION = /\b(?:no|not|don'?t|dont|wrong|revert|undo|stop|instead|that'?s not)\b/i;
const APPROVAL = /\b(?:nice|great|thanks|thank you|lgtm|looks good|ship it|perfect|good job|well done)\b/i;

/**
 * Type 3: three or more reliable edits to one file in a session. Reliable = an edit call with a recorded,
 * non-failed result. A Codex FileChange (or patch command) inside a code-mode exec whose own patch already names the
 * file is the same edit and counts once (dedupe by parentCallId). A candidate only: promoted when an interrupt landed
 * on an edit of the file; the player can also confirm it.
 */
export function editSequenceEpisodes(s: Session, min = 3): EditSequenceEpisode[] {
  if (s.agentAuthored) return [];
  const calls = allCalls(s);
  const byId = new Map(calls.map((c) => [c.callId, c]));
  const turnOf = new Map<string, Turn>();
  for (const t of s.turns) for (const c of t.calls) turnOf.set(c.callId, t);
  const perFile = new Map<string, ToolCall[]>();
  for (const c of calls) {
    if (!editOk(c)) continue;
    for (const f of c.files) {
      if (c.parentCallId) {
        const parent = byId.get(c.parentCallId);
        if (parent && parent.kind === 'edit' && parent.files.includes(f)) continue;
      }
      const list = perFile.get(f) ?? [];
      if (!list.includes(c)) list.push(c);
      perFile.set(f, list);
    }
  }
  const out: EditSequenceEpisode[] = [];
  for (const [file, edits] of perFile) {
    if (edits.length < min) continue;
    const first = edits[0]!;
    const last = edits[edits.length - 1]!;
    const firstT = turnOf.get(first.callId)!;
    const lastT = turnOf.get(last.callId)!;
    // Interrupt corroboration: an interrupt whose cut-off call edits this file, or that falls inside the sequence.
    let promoted = false;
    let promotedAt = -1;
    let negationNearEdit = false;
    let approvedAfter = false;
    let greenAfter = false;
    for (let i = 0; i < s.turns.length; i++) {
      const t = s.turns[i]!;
      if (t.role === 'interrupt') {
        if (i > firstT.i && i <= lastT.i + 1) {
          for (let k = i - 1; k >= 0; k--) {
            const a = s.turns[k]!;
            if (a.role === 'human') break;
            if (a.role === 'assistant' && a.calls.length) {
              const cut = a.calls[a.calls.length - 1]!;
              if (cut.kind === 'edit' && cut.files.includes(file) && !promoted) {
                promoted = true;
                promotedAt = i;
              }
              break;
            }
          }
          if (i > firstT.i && i < lastT.i && !promoted) {
            promoted = true;
            promotedAt = i;
          }
        }
      }
      if (t.role === 'human') {
        if (i > firstT.i && i < lastT.i && NEGATION.test(t.text)) negationNearEdit = true;
        if (i > lastT.i && NEGATION.test(t.text)) {
          const dt = t.ts && last.ts ? (Date.parse(t.ts) - Date.parse(last.ts)) / 1000 : null;
          if (dt !== null && dt >= 0 && dt <= 90) negationNearEdit = true;
        }
        if (i > lastT.i && !approvedAfter && APPROVAL.test(t.text) && !NEGATION.test(t.text)) approvedAfter = true;
      }
    }
    for (const c of calls) if (c.seq > last.seq && c.kind === 'shell' && isTestCommand(c.command) && c.result?.status === 'ok') greenAfter = true;
    const rel = relPath(file, s.cwd);
    let quote: string | null = null;
    if (promotedAt >= 0) {
      for (let k = promotedAt + 1; k < s.turns.length; k++) {
        const u = s.turns[k]!;
        if (u.role === 'injected') continue;
        if (u.role === 'human' && !gapBetween(s, s.turns[promotedAt]!.seq, u.seq)) quote = clip(u.text, QUOTE_LIMIT);
        break;
      }
    }
    out.push({
      id: `${s.id}:e${out.length}:${rel}`,
      type: 'edit-sequence',
      sessionId: s.id,
      agent: s.agent,
      projectKey: firstT.projectKey,
      projectLabel: firstT.projectKey !== null && firstT.projectKey === s.projectKey ? s.project : null,
      turn: firstT.i,
      ts: first.ts,
      file: rel,
      edits: edits.map((c) => c.callId),
      promoted,
      corroboratedBy: promotedAt >= 0 ? `${s.id}:i${promotedAt}` : null,
      negationNearEdit,
      approvedAfter,
      greenAfter,
      receipt: { quote, action: `${edits.length} edits to ${rel}`, result: describeResult(last) },
    });
  }
  return out;
}

// ------------------------------------------------------------------ type 4: genuine directive candidates

const STOP = new Set(
  'a an the and or but if then so to of in on at for with by from as is are was were be been it its this that these those i me my we our you your he she they them their there here do does did have has had will would can could should shall may might just also very really please ok okay yeah yes hey hi lets let us about into over under up down out again any some all each more most other such own same than too s t can will'.split(' '),
);
/** Words that carry meaning even though they are short or common: negation and exception language stay. */
const KEEP = new Set(['no', 'not', 'never', "don't", 'dont', 'only', 'except', 'unless', 'without', 'always', 'stop', 'avoid']);

/** Content tokens: lowercase words, paths and numbers kept whole; stopwords dropped; negation and exceptions kept. */
export function contentTokens(text: string): string[] {
  const words = text.toLowerCase().replace(/[`"'“”‘’]/g, (m) => (m === "'" || m === '’' ? "'" : ' ')).match(/[a-z0-9][a-z0-9._/'-]*/g) ?? [];
  const out: string[] = [];
  for (let w of words) {
    w = w.replace(/[.'-]+$/, '').replace(/^'+/, '');
    if (w === "don't" || w === 'dont' || w === 'do-not') w = "don't";
    if (!w) continue;
    if (STOP.has(w) && !KEEP.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** Exact normalisation: lowercase, punctuation folded to single spaces. */
export function normText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/._-]+/gu, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const A = new Set(a);
  let inter = 0;
  for (const x of new Set(b)) if (A.has(x)) inter++;
  return inter / (A.size + new Set(b).size - inter);
}

/**
 * Type 4 candidates in one session: genuine, typed (not pasted) human messages with at least three content tokens
 * and a directive word. They become a repeated directive only when the same text (exact-normalised, or content-token
 * Jaccard ≥ 0.72) appears in another session (see clusterDirectives in ./rooms.ts). Injected text never gets here.
 */
export function directiveCandidates(s: Session): DirectiveEpisode[] {
  if (s.agentAuthored) return [];
  const out: DirectiveEpisode[] = [];
  for (const t of s.turns) {
    if (t.role !== 'human' || isPasted(t.text)) continue;
    if (!DIRECTIVE_WORDS.test(t.text)) continue;
    const tokens = contentTokens(t.text);
    if (tokens.length < 3) continue;
    let afterInterrupt = false;
    for (let k = t.i - 1; k >= 0; k--) {
      const u = s.turns[k]!;
      if (u.role === 'injected') continue;
      afterInterrupt = u.role === 'interrupt';
      break;
    }
    out.push({
      id: `${s.id}:d${t.i}`,
      type: 'directive',
      sessionId: s.id,
      agent: s.agent,
      projectKey: t.projectKey,
      projectLabel: t.projectKey !== null && t.projectKey === s.projectKey ? s.project : null,
      turn: t.i,
      ts: t.ts,
      text: clip(t.text, QUOTE_LIMIT),
      norm: normText(t.text),
      tokens,
      humanTurn: t.i,
      afterInterrupt,
      receipt: { quote: clip(t.text, QUOTE_LIMIT), action: null, result: null },
    });
  }
  return out;
}

// ------------------------------------------------------------------ type 5: the narrow workflow recogniser

const RESULT_BEARING = /\b\d+ (?:passed|pass|tests?)\b|\bpass(?:es|ed)?\b.*\(\d+/i;
const CHANGE_WORDS = /\b(?:changed|updated|fixed|edited|modified)\b/i;

/**
 * Type 5, one occurrence: within one task (between two genuine human messages), a focused test run that passed
 * observably, then a diff review (git diff, with or without --stat) after it, then an assistant report after the diff
 * that names the change and carries the test result. Nothing broader is recognised.
 */
export function workflowEpisodes(s: Session): WorkflowEpisode[] {
  if (s.agentAuthored) return [];
  const out: WorkflowEpisode[] = [];
  let segStart = 0;
  const segments: [number, number][] = [];
  s.turns.forEach((t, i) => {
    if (t.role === 'human' && i > segStart) {
      segments.push([segStart, i]);
      segStart = i;
    }
  });
  segments.push([segStart, s.turns.length]);
  for (const [a, b] of segments) {
    const turns = s.turns.slice(a, b);
    const calls = turns.flatMap((t) => t.calls);
    const test = [...calls].reverse().find((c) => c.kind === 'shell' && isFocusedTest(c.command) && c.result?.status === 'ok');
    if (!test) continue;
    const diffs = calls.filter((c) => c.seq > test.seq && c.kind === 'shell' && c.command && /\bgit\s+diff\b/.test(c.command) && !!c.result && c.result.status !== 'error' && c.result.status !== 'rejected');
    if (diffs.length === 0) continue;
    const lastDiff = diffs[diffs.length - 1]!;
    const report = turns.find((t) => t.role === 'assistant' && (t.lastTextSeq ?? -1) > lastDiff.seq && RESULT_BEARING.test(t.text) && CHANGE_WORDS.test(t.text));
    if (!report) continue;
    const anchor = turns.find((t) => t.calls.includes(test)) ?? turns[0]!;
    out.push({
      id: `${s.id}:w${a}`,
      type: 'workflow',
      workflowKey: WORKFLOW_VERIFY,
      sessionId: s.id,
      agent: s.agent,
      projectKey: anchor.projectKey,
      projectLabel: anchor.projectKey !== null && anchor.projectKey === s.projectKey ? s.project : null,
      turn: anchor.i,
      ts: test.ts,
      test: fingerprint(test.command!),
      testProgram: programOf(test.command!),
      passEvidence: clip(test.result!.text, 120),
      diffs: diffs.map((c) => fingerprint(c.command!)),
      report: clip(report.text, QUOTE_LIMIT),
      callIds: [test.callId, ...diffs.map((c) => c.callId)],
      receipt: { quote: null, action: `${fingerprint(test.command!)} → ${diffs.map((c) => fingerprint(c.command!)).join(' → ')}`, result: clip(report.text, 160) },
    });
  }
  return out;
}

/** Every per-session detector. Cross-session promotion (types 4 and 5) happens in ./rooms.ts. */
export function detectEpisodes(s: Session): Episode[] {
  return [...interruptEpisodes(s), ...repeatedCommandEpisodes(s), ...editSequenceEpisodes(s), ...directiveCandidates(s), ...workflowEpisodes(s)];
}
