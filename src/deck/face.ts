// Face copy for the one fixed card box (play-loop §10, §14.6, §0a.5, §0a.20). A title of at most 20 characters and a
// summary of at most 64. When the exact exported line fits, the face is the exact line. Otherwise a deterministic
// template sentence for the response key, accepted only when it passes the two-way guard: every negation word,
// number, path and exception clause of the exact text appears in the summary, and the summary adds none. Anything
// else shows the exact text clamped and marked "Excerpt · inspect full line". No model writes a face.

import type { Card, ResponseKey } from './types';
import { contentTokens } from '../episodes';

export const TITLE_MAX = 20;
export const SUMMARY_MAX = 64;
export const EXCERPT_MARK = 'Excerpt · inspect full line';

export type FaceMode = 'exact' | 'summary' | 'excerpt';

export interface Face {
  /** At most TITLE_MAX characters. */
  title: string;
  /** At most SUMMARY_MAX visible characters (inline-code backticks do not render, so they do not count). */
  summary: string;
  /** exact = the exported line itself; summary = a guarded template sentence; excerpt = the exact text clamped. */
  mode: FaceMode;
  /** EXCERPT_MARK when the face is a clamped excerpt, else null. */
  mark: string | null;
  /** The exact line as it will land in the file. */
  exact: string;
}

/** One title per response key, each at most 20 characters. */
export const FACE_TITLES: Record<ResponseKey, string> = {
  inspect_error_before_retry: 'Read the error first',
  state_hypothesis_before_retry: 'Name the change',
  report_blocker_after_two: 'Stop after two',
  targeted_patch: 'One targeted patch',
  reproduce_first: 'Reproduce it first',
  summarise_hypotheses: 'Sum up what failed',
  preserve_boundary: 'Keep the stated line',
  confirm_scope_before_edit: 'Restate the scope',
  inspect_diff_against_boundary: 'Check the diff',
  standing_instruction: 'Standing instruction',
  reread_on_resume: 'Reread on resuming',
  record_at_handoff: 'Carry it over',
  verification_gate: 'Verification gate',
  result_summary: 'Report the result',
  mint_skill: 'Mint it as a Skill',
  unmapped: 'Your rule',
};

/** Characters as they render: inline-code backticks are not drawn. */
export function visibleLength(s: string): number {
  return s.replace(/`/g, '').length;
}

const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';

/** The narrowed-test standing instruction the templates write (see templates.ts). */
const NARROWED = /^(?:In [^,]{1,80}, )?when testing with `[^`]+`, run only the test file for the change; run the whole suite only when the user asks\.$/i;

function template(card: Card): string | null {
  const cmd = card.trigger.commandPrefix;
  const file = card.trigger.pathPrefix;
  switch (card.responseKey) {
    case 'inspect_error_before_retry':
      return cmd ? `Read the error before rerunning ${code(cmd)}.` : null;
    case 'state_hypothesis_before_retry':
      return cmd ? `Say what changed before rerunning ${code(cmd)}.` : null;
    case 'report_blocker_after_two':
      return cmd ? `After ${code(cmd)} fails twice, stop and report.` : null;
    case 'targeted_patch':
      return file ? `Make one targeted patch to ${code(file)}.` : null;
    case 'reproduce_first':
      return file ? `Reproduce the problem before editing ${code(file)}.` : null;
    case 'summarise_hypotheses':
      return file ? `Before a third edit to ${code(file)}, sum up the tries.` : null;
    case 'preserve_boundary':
      return 'Keep to the boundary the user stated, for the task.';
    case 'confirm_scope_before_edit':
      // P3: name the object the stop cut off, so the face keeps the guarded path or command (stall H: no excerpts).
      if (file || cmd) return `Restate the scope in one line after a stop in ${code((file ?? cmd)!)}.`;
      return 'After a stop, restate the scope in one line before editing.';
    case 'inspect_diff_against_boundary':
      if (file || cmd) return `After a stop in ${code((file ?? cmd)!)}, check the diff before done.`;
      return 'After a stop, check the diff against the line drawn.';
    case 'standing_instruction':
      return NARROWED.test(card.text) ? 'Run only the changed test file; whole suite only on request.' : null;
    case 'reread_on_resume':
      return 'Reread the standing instructions when resuming.';
    case 'record_at_handoff':
      return 'Write the standing constraint into handoff summaries.';
    case 'verification_gate':
      return 'Run the focused test and see it pass before done.';
    case 'result_summary':
      return 'When done, say what changed and the test result.';
    case 'mint_skill':
      return card.skillSlug ? `Use the ${code(card.skillSlug)} skill for fix-and-verify.` : null;
    case 'unmapped':
      return null;
  }
}

const NEGATIONS = new Set(['no', 'not', 'never', "don't", 'without', 'avoid', 'only', 'nothing', 'none', 'nor']);
const NUMBER_WORDS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'once', 'twice', 'thrice', 'first', 'second', 'third']);
const EXCEPTION = /\b(?:except|unless|other than|but only)\b[^.;]*/gi;

/** Words the guard protects: negation words, numbers (digits or spelled), and paths or file names. */
export function guardedTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of contentTokens(text)) if (NEGATIONS.has(t) || NUMBER_WORDS.has(t) || /\d/.test(t) || t.includes('/') || /\.[a-z0-9]{1,5}$/.test(t)) out.add(t);
  // contentTokens drops "no" and "nor" as stopwords on some paths; read them directly too.
  for (const m of text.toLowerCase().matchAll(/\b(no|nor|none|nothing)\b/g)) out.add(m[1]!);
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim();
function clauses(text: string): string[] {
  return [...text.matchAll(EXCEPTION)].map((m) => norm(m[0]).replace(/[,\s]+$/, ''));
}

export interface GuardResult {
  ok: boolean;
  /** Protected words or exception clauses of the exact text that the summary drops. */
  missing: string[];
  /** Protected words or exception clauses the summary adds. */
  added: string[];
}

/** The two-way guard between an exact line and a proposed summary. */
export function guardSummary(exact: string, summary: string): GuardResult {
  const e = guardedTokens(exact);
  const s = guardedTokens(summary);
  const sAll = new Set(contentTokens(summary));
  const eAll = new Set(contentTokens(exact));
  const missing = [...e].filter((t) => !s.has(t) && !sAll.has(t));
  const added = [...s].filter((t) => !e.has(t) && !eAll.has(t));
  const ns = norm(summary);
  const ne = norm(exact);
  for (const c of clauses(exact)) if (!ns.includes(c)) missing.push(c);
  for (const c of clauses(summary)) if (!ne.includes(c)) added.push(c);
  return { ok: missing.length === 0 && added.length === 0, missing, added };
}

/** The exact text cut to fit, at a word boundary, with an open code span closed before the ellipsis. */
export function clampExcerpt(text: string, max = SUMMARY_MAX): string {
  if (visibleLength(text) <= max) return text;
  let out = '';
  let visible = 0;
  for (const ch of text) {
    if (ch !== '`') {
      if (visible >= max - 1) break;
      visible++;
    }
    out += ch;
  }
  const cut = out.replace(/\s+\S*$/, '');
  let body = (cut.length >= out.length / 2 ? cut : out).replace(/[\s,;:]+$/, '');
  if ((body.match(/`/g) ?? []).length % 2 === 1) body += '`';
  return body + '…';
}

export function faceTitle(card: Card): string {
  if (card.type === 'protected') return card.sealed ? 'Protected text' : 'Your rule';
  if (card.family === 'imported') return 'Earlier rule';
  const t = FACE_TITLES[card.responseKey];
  return t.length <= TITLE_MAX ? t : t.slice(0, TITLE_MAX);
}

/**
 * A deterministic short form of the exact line (P3, stall H): the leading "In <project>, " (the scope ribbon shows
 * it) and every clause with no guarded word and no exception dropped; the rest joined with semicolons. Null when
 * nothing is left. The two-way guard still decides whether it may stand on the face.
 */
export function compressLine(exact: string): string | null {
  const body = exact.replace(/^In [^,`]{1,80}, /, '');
  const pieces = body.split(/(?<=[.;,])\s+/).map((x) => x.replace(/[.;,]+$/, '').trim()).filter((x) => x.length > 0);
  const kept = pieces.filter((x) => guardedTokens(x).size > 0 || /\b(?:except|unless|other than|but only)\b/i.test(x));
  if (kept.length === 0 || kept.length === pieces.length) return null;
  // Each kept clause reads as its own sentence; a trailing "instead" is filler once the clauses stand alone.
  return kept.map((x) => x.replace(/\s+instead$/i, '')).map((x) => `${x.charAt(0).toUpperCase()}${x.slice(1)}.`).join(' ');
}

/** The face of a card: exact line when it fits, a guarded template summary, a guarded short form, or a marked excerpt. */
export function faceCopy(card: Card): Face {
  const exact = card.text;
  const title = faceTitle(card);
  if (visibleLength(exact) <= SUMMARY_MAX) return { title, summary: exact, mode: 'exact', mark: null, exact };
  const tpl = template(card);
  if (tpl && visibleLength(tpl) <= SUMMARY_MAX && guardSummary(exact, tpl).ok) return { title, summary: tpl, mode: 'summary', mark: null, exact };
  const short = card.family === 'imported' ? null : compressLine(exact);
  if (short && visibleLength(short) <= SUMMARY_MAX && guardSummary(exact, short).ok) return { title, summary: short, mode: 'summary', mark: null, exact };
  return { title, summary: clampExcerpt(exact), mode: 'excerpt', mark: EXCERPT_MARK, exact };
}
