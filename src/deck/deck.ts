// The deck as the player sees it: the lines already in both global files (imported prose and earlier managed lines)
// plus the game cards taken this run. Changes to imported prose are explicit line edits (cut or replace in place);
// everything else in the files stays byte-for-byte. Rendering goes through ./lanes.ts.

import type { Agent } from '../model';
import type { Card, ExportMap, ResponseKey, Trigger } from './types';
import { BEGIN, END, parseGlobal, type ProtectedEdit } from './file';
import { buildLane, CLAUDE_LANE, codexLane, type LaneResult } from './lanes';
import { suggestClaims } from './claims';
import { shortHash } from './templates';
import { WORKFLOW_VERIFY } from '../episodes';

export type LineEdit = { kind: 'cut' } | { kind: 'replace'; text: string; scope?: Card['scope']; exceptions?: Card['exceptions'] };

export interface DeckState {
  readonly originals: { readonly claude: Uint8Array | null; readonly codex: Uint8Array | null; readonly codexOverride: Uint8Array | null };
  /** Cards read from the files: prose lines (type 'protected', ids p_…) and existing managed lines (their own ids). */
  readonly imported: readonly Card[];
  /** Player-approved edits to imported prose lines, by card id. */
  readonly edits: Readonly<Record<string, LineEdit>>;
  /** Existing managed lines the player cut. */
  readonly removedManaged: readonly string[];
  /** Game cards in the proposal (taken drafts, fused results, sharpened managed lines). */
  readonly cards: readonly Card[];
}

const dec = new TextDecoder();
const enc = new TextEncoder();

interface RawLine {
  start: number;
  end: number;
  text: string;
  eol: string;
}

function lines(b: Uint8Array): RawLine[] {
  const out: RawLine[] = [];
  let at = 0;
  while (at < b.length) {
    let nl = b.indexOf(10, at);
    const end = nl === -1 ? b.length : nl + 1;
    if (nl === -1) nl = b.length;
    let body = b.subarray(at, nl);
    let eol = nl < b.length ? '\n' : '';
    if (body.length && body[body.length - 1] === 13) {
      body = body.subarray(0, body.length - 1);
      eol = '\r' + eol;
    }
    out.push({ start: at, end, text: dec.decode(body), eol });
    at = end;
  }
  return out;
}

const BULLET = /^(\s*(?:[-*+]|\d+[.)])\s+)/;

/** Suggested mapping for imported prose: a family response the line already gives, or unmapped. Never accepted by default. */
export function suggestMapping(text: string): { trigger: Trigger; responseKey: ResponseKey } {
  const claims = suggestClaims(text);
  if (claims.some((c) => c.act === 'report' && c.object === 'result-summary')) return { trigger: { event: 'workflow_completed', workflowKey: WORKFLOW_VERIFY }, responseKey: 'result_summary' };
  if (claims.some((c) => c.polarity === 'do' && c.act === 'run' && c.object === 'tests:focused' && c.when === 'before-done')) return { trigger: { event: 'workflow_completed', workflowKey: WORKFLOW_VERIFY }, responseKey: 'verification_gate' };
  return { trigger: { event: [] }, responseKey: 'unmapped' };
}

/** Read the rule-like prose lines (outside the managed block, headings, fences and comments) and the managed lines. */
export function importFile(file: 'claude' | 'codex', bytes: Uint8Array | null): Card[] {
  if (!bytes || bytes.length === 0) return [];
  const p = parseGlobal(bytes);
  const agent: Agent = file;
  const out: Card[] = [];
  let fence = false;
  const seen = new Map<string, number>();
  for (const l of lines(bytes)) {
    if (p.block && l.start >= p.block.start && l.start < p.block.end) continue;
    const t = l.text;
    if (/^\s*(?:```|~~~)/.test(t)) {
      fence = !fence;
      continue;
    }
    if (fence || t.trim() === '' || /^\s*#/.test(t) || /^\s*<!--/.test(t) || /^\s*\|/.test(t) || /^\s*>/.test(t)) continue;
    const prefix = BULLET.exec(t)?.[1] ?? '';
    const text = t.slice(prefix.length).trim();
    if (text.length < 3 || text.includes(BEGIN) || text.includes(END)) continue;
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    const mapping = suggestMapping(text);
    out.push(
      Object.freeze({
        id: `p_${shortHash(`${file}|${text}|${n}`)}`,
        type: 'protected',
        family: 'imported',
        title: 'Your rule',
        targets: agent,
        scope: { kind: 'global' },
        trigger: Object.freeze(mapping.trigger),
        responseKey: mapping.responseKey,
        exceptions: Object.freeze([]),
        exceptionsReviewed: true,
        text,
        textRevision: 1,
        acceptedMappings: Object.freeze({}),
        evidenceRefs: Object.freeze([]),
        taken: true,
        claims: Object.freeze(suggestClaims(text)),
        source: { file, start: l.start, end: l.end, prefix, eol: l.eol },
        mappingSuggested: true,
      } as Card),
    );
  }
  for (const m of p.managed) {
    out.push(
      Object.freeze({
        id: m.id,
        type: m.section === 'workflows' ? 'skill' : 'rule',
        family: 'imported',
        title: 'Earlier reviewed rule',
        targets: agent,
        scope: { kind: 'global' },
        trigger: Object.freeze({ event: [] }),
        responseKey: 'unmapped',
        exceptions: Object.freeze([]),
        exceptionsReviewed: true,
        text: m.text,
        textRevision: 1,
        acceptedMappings: Object.freeze({}),
        evidenceRefs: Object.freeze([]),
        taken: true,
        claims: Object.freeze(suggestClaims(m.text)),
        mappingSuggested: true,
      } as Card),
    );
  }
  return out;
}

export function newDeck(claude: Uint8Array | null, codex: Uint8Array | null, codexOverride: Uint8Array | null = null): DeckState {
  return Object.freeze({
    originals: Object.freeze({ claude, codex, codexOverride }),
    imported: Object.freeze([...importFile('claude', claude), ...importFile('codex', codex)]),
    edits: Object.freeze({}),
    removedManaged: Object.freeze([]),
    cards: Object.freeze([]),
  });
}

/** True for a prose line read from a file (as opposed to a managed line or a game card). */
export function isProse(c: Card): boolean {
  return c.type === 'protected' && !!c.source;
}

/** The deck as it stands: imported lines with edits applied (cut ones gone), then game cards. */
export function presentCards(d: DeckState): Card[] {
  const out: Card[] = [];
  for (const c of d.imported) {
    if (isProse(c)) {
      const e = d.edits[c.id];
      if (e?.kind === 'cut') continue;
      out.push(e?.kind === 'replace' ? Object.freeze({ ...c, text: e.text, claims: Object.freeze(suggestClaims(e.text)), ...(e.scope ? { scope: e.scope } : {}), ...(e.exceptions ? { exceptions: e.exceptions } : {}) }) : c);
    } else {
      if (d.removedManaged.includes(c.id) || d.cards.some((g) => g.id === c.id)) continue;
      out.push(c);
    }
  }
  out.push(...d.cards);
  return out;
}

function protectedEdits(d: DeckState, file: 'claude' | 'codex'): ProtectedEdit[] {
  const out: ProtectedEdit[] = [];
  for (const c of d.imported) {
    if (!isProse(c) || c.source!.file !== file) continue;
    const e = d.edits[c.id];
    if (!e) continue;
    out.push({ start: c.source!.start, end: c.source!.end, text: e.kind === 'cut' ? null : e.text, prefix: c.source!.prefix, eol: c.source!.eol });
  }
  return out;
}

export interface Lanes {
  claude: LaneResult;
  codex: LaneResult;
}

export function renderLanes(d: DeckState, raised: { claude?: number; codex?: number } = {}): Lanes {
  const removed = new Set(d.removedManaged);
  const taken = d.cards.filter((c) => c.taken);
  return {
    claude: buildLane(CLAUDE_LANE, d.originals.claude, taken, removed, raised.claude, protectedEdits(d, 'claude')),
    codex: buildLane(codexLane(d.originals.codexOverride), d.originals.codex, taken, removed, raised.codex, protectedEdits(d, 'codex')),
  };
}

/**
 * The cover rule's "in the proposed export": managed ids read back from the rendered bytes, plus imported prose lines
 * that the rendered file still carries (not cut, and the lane not blocked).
 */
export function deckExportMap(d: DeckState, lanes: Lanes): ExportMap {
  const ids = (agent: Agent, l: LaneResult) => {
    const set = new Set(parseGlobal(l.next).managed.map((m) => m.id));
    if (!l.blocker) for (const c of d.imported) if (isProse(c) && c.source!.file === agent && d.edits[c.id]?.kind !== 'cut') set.add(c.id);
    return set;
  };
  return { claude: ids('claude', lanes.claude), codex: ids('codex', lanes.codex) };
}

export function withCards(d: DeckState, cards: readonly Card[]): DeckState {
  return Object.freeze({ ...d, cards: Object.freeze([...cards]) });
}

export function withEdit(d: DeckState, id: string, e: LineEdit | null): DeckState {
  const edits = { ...d.edits };
  if (e === null) delete edits[id];
  else edits[id] = e;
  return Object.freeze({ ...d, edits: Object.freeze(edits) });
}

export const bytesOf = (s: string) => enc.encode(s);
