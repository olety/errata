// The noise filter (spec §2, type 2): results that look like failures but are not the agent's command failing.
// Each is a named negative with fixtures. A genuine failure needs status 'error' from an exit code or a harness
// error flag AND no negative. Unknown stays unknown: unknown is never failure, and never success unless an
// observable pass pattern says so (statusFrom 'output').

import type { Session, ToolCall } from './model';
import { allCalls } from './model';
import { exitProgramOf, fingerprint } from './parse/common';

export type NegativeKind =
  /** The player or the harness declined the call ("The user doesn't want to proceed", rejected tool use). */
  | 'harness-rejected'
  /** A permission system, sandbox or hook refused the call before it ran. */
  | 'permission-denied'
  /** The session's worktree isolation refused a command or path outside the worktree. */
  | 'worktree-refusal'
  /** A search or comparison that found nothing (grep/rg exit 1, diff --exit-code). */
  | 'no-match'
  /** A test written to fail first (red before green): the run follows a test-file edit and later passes. */
  | 'expected-red';

export const NEGATIVE_LABELS: Record<NegativeKind, string> = {
  'harness-rejected': 'declined before running',
  'permission-denied': 'refused before running (a permission, sandbox, hook or harness error)',
  'worktree-refusal': 'refused by worktree isolation',
  'no-match': 'a search that found nothing',
  'expected-red': 'a test written to fail first',
};

// Anchored at the start of the result (after an optional "Error:" or tool-error wrapper): a log that merely mentions a
// rejection somewhere in its output is still the command's own result.
const REJECTED: RegExp[] = [
  /^The user doesn't want to proceed/,
  /^The tool use was rejected/i,
  /^User rejected/i,
  /^(?:exec )?command (?:was )?rejected by (?:the )?user\b/i,
  /^(?:patch )?rejected by (?:the )?user\b/i,
  /^\[Request interrupted by user/,
];

const DENIED: RegExp[] = [
  /^PreToolUse:\S* ?hook error\b/i,
  /^\S+ hook (?:error|blocked|denied)\b/i,
  /Permission to use .{1,240}? (?:has been|was) denied/i,
  /requested permissions? to .{0,200}haven'?t granted/i,
  /\bhaven'?t granted it yet\b/i,
  /\bblocked by (?:a |the )?(?:\w+ )?hook\b/i,
  /\bhook (?:blocked|denied|rejected)\b/i,
  /\bdenied by (?:the )?sandbox\b/i,
  /\bsandbox (?:denied|blocked|refused)\b/i,
  /\bnot permitted by (?:the )?(?:sandbox|policy)\b/i,
  /\bapproval (?:was )?(?:denied|declined)\b/i,
];

const WORKTREE: RegExp[] = [
  /This session is isolated in the worktree/i,
  /\bhasn'?t isolated its changes\b/i,
  /\boutside (?:of )?(?:the|this|your) (?:session'?s )?(?:worktree|isolated worktree)\b/i,
  /\bworktree isolation\b/i,
];

/** Text-level negative for one result. The result head is enough: every pattern sits at or near the start. */
export function textNegative(c: ToolCall): NegativeKind | null {
  const r = c.result;
  if (!r) return null;
  if (r.status === 'rejected') return 'harness-rejected';
  if (r.status === 'nomatch') return 'no-match';
  if (r.status !== 'error' && r.status !== 'unknown') return null;
  const raw = r.text.slice(0, 600).trimStart();
  // Claude Code wraps tool errors raised by the harness itself (not by the command) in <tool_use_error>.
  const wrapped = /^<tool_use_error>/.test(raw);
  const head = raw.replace(/^<tool_use_error>\s*/, '').replace(/^(?:Error:\s*)+/, '');
  if (WORKTREE.some((re) => re.test(head))) return 'worktree-refusal';
  if (DENIED.some((re) => re.test(head))) return 'permission-denied';
  if (REJECTED.some((re) => re.test(head))) return 'harness-rejected';
  // Any other harness tool error on a command means the command never ran: refused before running.
  if (wrapped && c.kind === 'shell') return 'permission-denied';
  return null;
}

// ------------------------------------------------------------------ test commands and observable passes

const TEST_CMD =
  /(?:^|[\s;&|(])(?:pytest|py\.test|jest|vitest|mocha|rspec|phpunit|ctest|nextest)(?=\s|$)|(?:^|[\s;&|(])(?:go|cargo|bun|deno|npm|pnpm|yarn|mvn|gradle|make|dotnet|swift|mix|uv|poetry)\s+(?:run\s+)?(?:test|pytest)(?=\s|$|:)|python3?\s+-m\s+(?:pytest|unittest)\b/;

/** True when a command line runs a test runner. */
export function isTestCommand(command: string | null): boolean {
  return !!command && TEST_CMD.test(fingerprint(command));
}

/** A test run narrowed to a file, a test id or a filter (not the whole suite). */
export function isFocusedTest(command: string | null): boolean {
  if (!command || !isTestCommand(command)) return false;
  const fp = fingerprint(command);
  return /(?:\S+\.(?:py|ts|tsx|js|jsx|mjs|go|rs|rb|php)\b|::|\s-k\s|\s--filter\b|\s-t\s|\s--grep\b|\s-run\s|\stests?\/\S+)/.test(fp);
}

const PASS: RegExp[] = [/\b\d+ passed\b/, /\b\d+ pass\b[\s\S]*\b0 fail\b/, /\btest result: ok\b/, /^ok\s+\S+/m, /Tests:\s+\d+ passed/];
const FAIL: RegExp[] = [/\b[1-9]\d* (?:failed|errors?)\b/, /\b[1-9]\d* fail\b/, /\bFAILED\b/, /\bFAIL\b/, /test result: FAILED/, /Traceback \(most recent call last\)/, /\bError:/];

/** An observable pass in a test runner's output, with no failure marker. */
export function observablePass(text: string): boolean {
  return PASS.some((re) => re.test(text)) && !FAIL.some((re) => re.test(text));
}

const EDIT_OK: RegExp[] = [/has been (?:edited|updated)/, /^Success\. Updated the following files/m, /^(?:Wrote|Updated|Created) \S/m];

// ------------------------------------------------------------------ test files

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go|rs)$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)[^/]+_spec\.rb$/;

export function isTestPath(p: string): boolean {
  return TEST_PATH.test(p);
}

// ------------------------------------------------------------------ session pass

function editsOf(c: ToolCall): string[] {
  if (c.kind !== 'edit') return [];
  const st = c.result?.status;
  if (st === 'error' || st === 'rejected' || st === 'interrupted') return [];
  return c.files;
}

/**
 * Annotate a parsed session in place: text negatives, observable passes and edit confirmations for results with
 * no exit code, then the contextual expected-red negative. Idempotent.
 */
export function annotateSession(s: Session): Session {
  const calls = allCalls(s);
  for (const c of calls) {
    const r = c.result;
    if (!r) continue;
    if (r.status === 'unknown' && c.kind === 'shell' && isTestCommand(c.command) && observablePass(r.text)) {
      r.status = 'ok';
      r.statusFrom = 'output';
    }
    if (r.status === 'unknown' && c.kind === 'edit' && EDIT_OK.some((re) => re.test(r.text.slice(0, 300)))) {
      r.status = 'ok';
      r.statusFrom = 'output';
    }
    const neg = textNegative(c);
    if (neg) r.negative = neg;
  }
  markExpectedRed(s);
  return s;
}

/**
 * Expected red: a failing test run whose nearest preceding edit (since the last human message) touched a test file,
 * with no non-test edit in between, followed later by a passing test run after an edit to a non-test file.
 * Only the first such failure of each red phase is marked; a second unchanged failure is a genuine retry.
 */
function markExpectedRed(s: Session): void {
  type Ev = { c: ToolCall; humanBefore: boolean };
  const evs: Ev[] = [];
  let sawHuman = false;
  for (const t of s.turns) {
    if (t.role === 'human') sawHuman = true;
    for (const c of t.calls) {
      evs.push({ c, humanBefore: sawHuman });
      sawHuman = false;
    }
  }
  let lastEditWasTest = false;
  let redOpen = false;
  for (let i = 0; i < evs.length; i++) {
    const { c, humanBefore } = evs[i]!;
    if (humanBefore) {
      lastEditWasTest = false;
      redOpen = false;
    }
    const files = editsOf(c);
    if (files.length) {
      lastEditWasTest = files.every(isTestPath);
      if (!lastEditWasTest) redOpen = false;
      continue;
    }
    if (c.kind !== 'shell' || !isTestCommand(c.command) || c.result?.status !== 'error' || c.result.negative) continue;
    if (!lastEditWasTest || redOpen) continue;
    // Look ahead: a non-test edit, then a passing test run, before the next human message.
    let implEdit = false;
    let green = false;
    for (let j = i + 1; j < evs.length; j++) {
      const e = evs[j]!;
      if (e.humanBefore) break;
      if (editsOf(e.c).some((f) => !isTestPath(f))) implEdit = true;
      if (implEdit && e.c.kind === 'shell' && isTestCommand(e.c.command) && e.c.result?.status === 'ok') {
        green = true;
        break;
      }
    }
    if (green) {
      c.result.negative = 'expected-red';
      redOpen = true;
    }
  }
}

/** A genuinely unsuccessful result: an error status from an exit code or an error flag, and no named negative. */
export function isGenuineFailure(c: ToolCall): boolean {
  return c.result?.status === 'error' && !c.result.negative;
}

/** Counts of named negatives across sessions, for the mirror. */
export function negativeCounts(sessions: Session[]): Record<NegativeKind, number> {
  const out: Record<NegativeKind, number> = { 'harness-rejected': 0, 'permission-denied': 0, 'worktree-refusal': 0, 'no-match': 0, 'expected-red': 0 };
  for (const s of sessions) for (const c of allCalls(s)) if (c.result?.negative) out[c.result.negative]++;
  return out;
}

export { exitProgramOf };
