// The play loop's adapter: the ONLY play-loop module that imports the engine. select* turn the game state into the
// views in ./contract.ts; act* are transitions from one state to the next (Apply's go through an ApplyPort and are
// async). Every number a view carries is computed here, with its honesty-map source (play-loop §13) in a JSDoc line.
// Workers never import this file's internals; the controller calls it and hands views down.

import type { Agent } from '../../model';
import type { Analysis } from '../../pipeline';
import type { Episode } from '../../episodes';
import { buildRoute, caseFor, ineligibility, type Room, type RouteNode } from '../../rooms';
import type { Card, Case, Disposition as EngineDisposition, Targets } from '../../deck/types';
import { draftCards } from '../../deck/templates';
import { faceCopy } from '../../deck/face';
import { lineWeight, sanitizeLine, text as utf8 } from '../../deck/file';
import { acceptImportMapping, acceptOnCase, deckExportMap, isProse, presentCards, renderLanes, suggestMapping, withCards, withEdit, type DeckState } from '../../deck/deck';
import { applyFuse, conflicts, cutCard, fuseSuggestions, previewChange, previewFuse, previewSettlement, removeCard, resolveConflict, sharpen, type Conflict, type FuseSuggestion, type Preview, type Resolution } from '../../deck/campfire';
import { cover, coverage, coverPreview } from '../../cover';
import { acceptOnHead, answerBoss, bossTally, headResults, openPile, playCard, previewDrop, retarget, tallyCurrent, weightPreview, withProposed, type BossTally, type DropTarget, type WeightLane, type WeightPreview } from '../../play';
import { lineDiff } from '../../deck/diff';
import { applyTargets, skillSpecFor, type ApplyTargets } from '../../deck/skill-plan';
import { renderSkill } from '../../deck/skill';
import { applyPlan, makePlan, undoBundle } from '../../apply/engine';
import type { ApplyResult, Plan, Root, UndoResult } from '../../apply/types';
import * as C from './contract';

// ------------------------------------------------------------------ state

export interface RoomProgress {
  phase: C.RoomPhase;
  /** The receipt on the stage (a case id), or null for the queue's first unstamped head. */
  receipt: string | null;
  result: C.PlayResultView | null;
}

export interface ApplyState {
  targets: ApplyTargets | null;
  plan: Plan | null;
  result: ApplyResult | null;
  undo: UndoResult | null;
  error: string | null;
}

/** The whole game state. Opaque to workers: they see views only. Every field is replaced, never mutated. */
export interface PlayState {
  readonly analysis: Analysis;
  readonly rooms: readonly Room[];
  readonly route: readonly RouteNode[];
  /** Index into route, and the room index inside a multi-room node. */
  readonly node: number;
  readonly sub: number;
  readonly disp: Readonly<Record<string, EngineDisposition>>;
  readonly deck: DeckState;
  readonly progress: Readonly<Record<string, RoomProgress>>;
  /** Drafts dealt and not taken this act. Never written. */
  readonly shelf: readonly Card[];
  /** Cards cut at a fire, restorable until Apply. */
  readonly ash: readonly Card[];
  readonly campfire: { tab: C.LaneTab; focus: { a: string; b: string; threadId: string | null } | null; pinned: string | null };
  readonly boss: { index: number; locked: { revision: string; tally: BossTally } | null };
  readonly apply: ApplyState;
  readonly wording: Readonly<Record<string, string>>;
  readonly sample: boolean;
  readonly loaded: { claude: boolean; codex: boolean };
  /** Explicit allowance raises by the player, per lane (printed on the end screen). */
  readonly raised: { claude?: number; codex?: number };
}

export function createPlayState(o: { analysis: Analysis; deck: DeckState; sample: boolean; loaded?: { claude: boolean; codex: boolean }; disp?: Record<string, EngineDisposition> }): PlayState {
  return Object.freeze({
    analysis: o.analysis,
    rooms: o.analysis.rooms,
    route: o.analysis.route.nodes,
    node: 0,
    sub: 0,
    disp: Object.freeze({ ...(o.disp ?? {}) }),
    deck: o.deck,
    progress: Object.freeze({}),
    shelf: Object.freeze([]),
    ash: Object.freeze([]),
    campfire: { tab: 'both' as const, focus: null, pinned: null },
    boss: { index: 0, locked: null },
    apply: { targets: null, plan: null, result: null, undo: null, error: null },
    wording: Object.freeze({}),
    sample: o.sample,
    loaded: o.loaded ?? { claude: true, codex: true },
    raised: {},
  });
}

const upd = (s: PlayState, p: Partial<PlayState>): PlayState => Object.freeze({ ...s, ...p });

// ------------------------------------------------------------------ small readers

const AGENTS: readonly Agent[] = ['claude', 'codex'];
const day = (ts: string | null) => (ts ? ts.slice(0, 10) : null);
const dispOf = (s: PlayState, id: string): EngineDisposition => s.disp[id] ?? 'unreviewed';

export function currentNode(s: PlayState): RouteNode | undefined {
  return s.route[s.node];
}

export function currentRoom(s: PlayState): Room | undefined {
  const n = currentNode(s);
  if (!n || n.rooms.length === 0) return undefined;
  return s.rooms.find((r) => r.key === n.rooms[Math.min(s.sub, n.rooms.length - 1)]);
}

function roomByKey(s: PlayState, key: string): Room | undefined {
  return s.rooms.find((r) => r.key === key);
}

function progressOf(s: PlayState, key: string): RoomProgress {
  return s.progress[key] ?? { phase: 'judge', receipt: null, result: null };
}

/** The room as the engine drafts it: an event stamped a problem becomes a one-head room with drafts (§8). */
function draftRoom(s: PlayState, r: Room): Room {
  return r.kind === 'event' && dispOf(s, r.anchor.id) === 'issue' ? { ...r, kind: 'encounter', family: 'boundary' } : r;
}

/** Heads in order: the anchor first, then by date. One head per selected case (§0a.6). */
function headEpisodes(r: Room): Episode[] {
  const rest = r.episodes.filter((e) => e !== r.anchor).sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  return [r.anchor, ...rest];
}

/** The room's cases with the player's stamps. Honesty map: case facts from caseFor (rooms.ts); disposition = the stamp. */
function roomCases(s: PlayState, r: Room): Case[] {
  return headEpisodes(r).map((e) => ({ ...caseFor(e, r), disposition: dispOf(s, e.id) }));
}

function withheldCases(s: PlayState, r: Room): Case[] {
  return [...r.withheld].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? '')).map((e) => ({ ...caseFor(e, r), disposition: dispOf(s, e.id) }));
}

/** Rooms placed on the route, in route order. */
function placedRooms(s: PlayState): Room[] {
  const out: Room[] = [];
  for (const n of s.route) for (const k of n.rooms) {
    const r = roomByKey(s, k);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * Confirmed cases run-wide: stamped a problem in a room whose stamps are final, plus withheld cases stamped a problem
 * at the boss. Honesty map: "confirmed issues, run-wide" (§13, Open pile).
 */
function confirmedCases(s: PlayState): Case[] {
  const out: Case[] = [];
  for (const r of placedRooms(s)) {
    if (progressOf(s, r.key).phase === 'done' && r.kind !== 'workshop') out.push(...roomCases(s, draftRoom(s, r)).filter((c) => c.disposition === 'issue'));
    if (r.withheld.length) out.push(...withheldCases(s, r).filter((c) => c.disposition === 'issue'));
  }
  return out;
}

/** Every case the player has given a disposition (for coverage previews at the fire). */
function reviewedCases(s: PlayState): Case[] {
  const out: Case[] = [];
  for (const r of placedRooms(s)) for (const c of [...roomCases(s, draftRoom(s, r)), ...withheldCases(s, r)]) if (c.disposition !== 'unreviewed') out.push(c);
  return out;
}

function exportOf(d: DeckState) {
  return deckExportMap(d, renderLanes(d, {}));
}

function receiptOf(e: Episode): C.ReceiptView {
  return {
    caseId: e.id,
    quote: e.receipt.quote,
    pasted: e.type === 'interrupt' ? e.pasted : false,
    action: e.receipt.action,
    result: e.receipt.result,
    then: e.receipt.then ?? null,
    agent: e.agent,
    project: e.projectLabel,
    date: day(e.ts),
  };
}

function episodeOf(s: PlayState, id: string): Episode | undefined {
  for (const r of s.rooms) {
    const e = r.episodes.find((x) => x.id === id) ?? r.withheld.find((x) => x.id === id);
    if (e) return e;
  }
  return undefined;
}

function roomOfCase(s: PlayState, id: string): Room | undefined {
  return s.rooms.find((r) => r.episodes.some((x) => x.id === id) || r.withheld.some((x) => x.id === id));
}

// ------------------------------------------------------------------ numbers → views

/** Honesty map: ghost strap = weigh(renderLanes(after)).total − weigh(renderLanes(before)).total per file (§13). */
function ghost(w: WeightLane): C.GhostDelta {
  const g = { before: w.before, after: w.after, delta: w.delta, line: w.line, blockHeader: w.blockHeader, other: w.other };
  return { ...g, text: C.ghostText(g) };
}

function ghosts(w: WeightPreview): { claude: C.GhostDelta; codex: C.GhostDelta } {
  return { claude: ghost(w.claude), codex: ghost(w.codex) };
}

const ZERO_GHOST = (s: PlayState) => ghosts(weightPreview(s.deck, s.deck));

/** Honesty map: Provenance seal = distinct sessions in evidenceRefs; Verified = a workflow seen in ≥ 2 sessions (§13). */
function provenance(c: Card): string {
  if (c.family === 'imported') return 'From your file';
  const n = new Set(c.evidenceRefs.map((r) => r.sessionId)).size;
  if (c.family === 'workflow' && n >= 2) return 'Verified';
  return n >= 2 ? `Repeated · ${n}` : 'Observed';
}

function triggerText(c: Card): string | null {
  if (c.family === 'imported' && c.mappingSuggested) return null;
  const t = c.trigger;
  const ev = (typeof t.event === 'string' ? [t.event] : [...t.event]).join(' or ').replace(/_/g, ' ');
  const parts = [ev];
  if (t.commandPrefix) parts.push(`command ${t.commandPrefix}`);
  if (t.pathPrefix) parts.push(`path ${t.pathPrefix}`);
  if (t.constraintKey) parts.push('the stated line');
  if (t.workflowKey) parts.push('the verified workflow');
  return parts.join(' · ');
}

function sessionLabel(s: PlayState, sessionId: string): { agent: Agent; date: string | null; label: string } {
  const ss = s.analysis.sessions.find((x) => x.id === sessionId);
  return { agent: ss?.agent ?? 'claude', date: day(ss?.startedAt ?? null), label: ss?.file ?? sessionId };
}

/**
 * A card view. Honesty map: weight orb = lineWeight(text, id), bytes ÷ 3 of the rendered line; sigils and scope
 * ribbon = card.targets / card.scope; face = faceCopy (guarded template or exact text); inFiles = the rendered files'
 * export map (deckExportMap).
 */
function cardView(s: PlayState, c: Card, ctx?: { room: Room; heads: Case[]; unavailable?: string[] }): C.CardView {
  const f = faceCopy(c);
  const weight = lineWeight(c.text, c.id);
  const bytes = new TextEncoder().encode(`- ${sanitizeLine(c.text)} <!-- deck:${c.id} -->\n`).length;
  const ex = exportOf(s.deck);
  let footer: C.CardView['footer'] = null;
  if (ctx) {
    /** Honesty map: "would address" = preview-mode cover count over the room's bared heads (§13), against displayed targets. */
    const pv = previewDrop(s.deck, c, ctx.heads.filter((h) => h.disposition === 'issue'), 'beast');
    const cards = presentCards(s.deck);
    const newly = pv.heads.filter((h) => h.preview.eligible && !cards.some((k) => cover(k, ctx.heads.find((x) => x.id === h.caseId)!, ex).covers)).length;
    footer = { eligible: pv.eligible.length, newly, text: C.footerText(pv.eligible.length, newly) };
  }
  const room = ctx?.room ?? s.rooms.find((r) => r.episodes.some((e) => c.evidenceRefs.some((x) => x.sessionId === e.sessionId))) ?? null;
  let skill: C.CardInspectorView['skill'] = null;
  if (c.type === 'skill' && c.family !== 'imported') {
    const r = renderSkill(skillSpecFor(c, room && room.family === 'workflow' ? room : null));
    /** Honesty map: Skill body = SKILL.md bytes ÷ 3, shown separately and labelled outside the allowance (§13). */
    skill = { firstLines: r.text.split('\n').slice(0, 6), estimate: Math.ceil(r.bytes.length / 3) };
  }
  return {
    id: c.id,
    type: c.type,
    face: { title: f.title, summary: f.summary, mode: f.mode, mark: f.mark },
    weight,
    targets: c.targets,
    sigils: { claude: c.targets !== 'codex', codex: c.targets !== 'claude' },
    scope: c.scope.kind === 'global' ? 'global' : c.scope.label,
    exceptions: c.exceptions.map((e) => e.text),
    provenance: provenance(c),
    footer,
    inFiles: AGENTS.filter((a) => ex[a].has(c.id)),
    inspector: {
      exact: c.text,
      targets: c.targets,
      scope: c.scope.kind === 'global' ? 'all projects' : c.scope.label,
      trigger: triggerText(c),
      exceptions: c.exceptions.map((e) => e.text),
      weightMath: `${bytes} bytes ÷ 3 = ${weight}`,
      quote: room && c.family !== 'imported' ? room.anchor.receipt.quote : null,
      evidence: [...new Set(c.evidenceRefs.map((r) => r.sessionId))].map((id) => {
        const l = sessionLabel(s, id);
        return { agent: l.agent, date: l.date, sessionLabel: l.label };
      }),
      needsAcceptance: !!c.mappingSuggested && suggestMapping(c.text).responseKey !== 'unmapped',
      skill,
      unavailable: ctx?.unavailable ?? [],
    },
  };
}

// ------------------------------------------------------------------ heads and beasts

const SKINS: Record<Room['family'], C.Skin> = { directive: 'suite-wyrm', 'repeated-command': 'retry-hydra', boundary: 'boundary-stag', rewrite: 'patch-moth', workflow: 'owl' };

/** Honesty map: neck rings = failures.length (repeated command) or edits.length (rewrite) in that one case (§13). */
function rings(e: Episode): C.HeadView['rings'] {
  if (e.type === 'repeated-command') return { count: e.failures.length, counts: 'failed runs' };
  if (e.type === 'edit-sequence') return { count: e.edits.length, counts: 'edits' };
  return null;
}

/** Honesty map: wrapped / bared / heron / sunk = the player's stamp; bound = cover() true for some proposed card (§13). */
function headState(s: PlayState, r: Room, c: Case, bound: boolean): C.HeadState {
  if (r.kind === 'workshop') return 'lantern';
  switch (c.disposition) {
    case 'unreviewed':
    case 'unclear':
      return 'wrapped';
    case 'pivot':
      return 'heron';
    case 'not-a-problem':
      return 'sunk';
    case 'issue':
      return bound ? 'bound' : progressOf(s, r.key).phase === 'done' ? 'standing' : 'bared';
  }
}

function headViews(s: PlayState, r: Room): C.HeadView[] {
  const dr = draftRoom(s, r);
  const cases = roomCases(s, dr);
  const cards = presentCards(s.deck);
  const ex = exportOf(s.deck);
  return headEpisodes(r).map((e, i) => {
    const c = cases[i]!;
    const bound = c.disposition === 'issue' && cards.some((k) => cover(k, c, ex).covers);
    return { caseId: e.id, state: headState(s, dr, c, bound), disposition: c.disposition, tag: { agent: e.agent, project: e.projectLabel, date: day(e.ts) }, rings: rings(e), socket: i < 5 ? i : null, receipt: receiptOf(e) };
  });
}

/** Honesty map: pips = coverage() addressed / confirmed in the room; unreviewed = wrapped heads (§13, §0a.6). */
function pips(s: PlayState, r: Room, heads: C.HeadView[]): C.PipsView {
  const cases = roomCases(s, draftRoom(s, r));
  const cov = coverage(presentCards(s.deck), cases, exportOf(s.deck));
  const unreviewed = heads.filter((h) => h.state === 'wrapped').length;
  return { addressed: cov.addressed, confirmed: cov.confirmed, unreviewed, text: C.pipsText(cov.addressed, cov.confirmed, unreviewed), fully: cov.confirmed > 0 && cov.addressed === cov.confirmed && unreviewed === 0 };
}

function beast(s: PlayState, r: Room, heads: C.HeadView[]): C.BeastView {
  const drawn = heads.filter((h) => h.socket !== null);
  const rest = heads.filter((h) => h.socket === null);
  /** Honesty map: "+N" = the exact number of heads past five, with their bound and unreviewed counts (§22). */
  const overflow = rest.length
    ? { more: rest.length, bound: rest.filter((h) => h.state === 'bound').length, unreviewed: rest.filter((h) => h.state === 'wrapped').length, text: C.overflowText(rest.length, rest.filter((h) => h.state === 'bound').length, rest.filter((h) => h.state === 'wrapped').length) }
    : null;
  return { roomKey: r.key, skin: r.kind === 'event' ? 'heron' : SKINS[r.family], name: r.name, subtitle: r.subtitle, heads: drawn, overflow, pips: pips(s, r, heads) };
}

// ------------------------------------------------------------------ books, piles, route, status

/** Honesty map: strap = weigh(next).total vs budgetFor(original).allowance; clasp open = over the allowance (§13). */
export function selectBooks(s: PlayState): C.BookView[] {
  const L = renderLanes(s.deck, s.raised);
  const ex = exportOf(s.deck);
  const applied = s.apply.result?.status === 'written';
  return AGENTS.map((a) => {
    const l = L[a];
    return {
      lane: a,
      file: C.FILE_OF[a],
      path: l.lane.label,
      proposed: !applied,
      loaded: s.loaded[a],
      weight: { now: l.after.total, allowance: l.allowance, over: l.after.total > l.allowance, noGrowth: l.noGrowth, raisedBy: s.raised[a] ?? null },
      blocked: l.blocker,
      cardIds: presentCards(s.deck).filter((c) => ex[a].has(c.id)).map((c) => c.id),
    };
  });
}

/** Honesty map: Open pile = confirmed issues, run-wide, with no covering card; a set keyed by case id (§13, §0a.7). */
export function selectPiles(s: PlayState): C.PilesView {
  const open = openPile(s.deck, confirmedCases(s));
  return {
    shelf: s.shelf.map((c) => cardView(s, c)),
    open: open.map((id) => {
      const e = episodeOf(s, id)!;
      return { caseId: id, roomKey: roomOfCase(s, id)?.key ?? '', tag: { agent: e.agent, project: e.projectLabel, date: day(e.ts) }, receipt: receiptOf(e) };
    }),
  };
}

function nodeLabel(s: PlayState, n: RouteNode): string {
  const rs = n.rooms.map((k) => roomByKey(s, k)).filter((x): x is Room => !!x);
  switch (n.kind) {
    case 'encounter':
    case 'elite':
    case 'review':
      return rs.map((r) => r.name).join(', ');
    case 'event':
      return 'A change of plan';
    case 'workshop':
      return 'The workshop';
    case 'card-review':
      return 'Your existing rules';
    case 'campfire':
      return 'Campfire';
    case 'boss':
      return 'Later cases';
    case 'audit':
      return 'Final audit';
    case 'apply':
      return 'Apply';
  }
}

/**
 * Honesty map: route knot marks = per room open count, unreviewed count, head count and agent sigils; sealed heads =
 * sum of room.withheld over placed rooms, sigils = their agents, nothing else (§13).
 */
export function selectRoute(s: PlayState): C.RouteView {
  const open = new Set(openPile(s.deck, confirmedCases(s)));
  const knots = s.route.map((n, i) => {
    const rs = n.rooms.map((k) => roomByKey(s, k)).filter((x): x is Room => !!x && n.kind !== 'boss');
    const eps = rs.flatMap((r) => r.episodes);
    return {
      slot: n.slot,
      kind: n.kind,
      label: nodeLabel(s, n),
      state: i < s.node ? ('done' as const) : i === s.node ? ('current' as const) : ('ahead' as const),
      open: eps.filter((e) => open.has(e.id)).length,
      unreviewed: rs.filter((r) => r.kind !== 'workshop').flatMap((r) => r.episodes).filter((e) => ['unreviewed', 'unclear'].includes(dispOf(s, e.id))).length,
      heads: eps.length,
      sigils: [...new Set(eps.map((e) => e.agent))],
    };
  });
  const held = placedRooms(s).flatMap((r) => r.withheld);
  return { knots, current: s.node, sealed: { count: held.length, sigils: [...new Set(held.map((e) => e.agent))] } };
}

/** Honesty map: status = the import's real session count; "synthetic sample" on the sample (§13 start screen). */
export function selectStatus(s: PlayState): C.StatusView {
  const n = s.analysis.sessions.length;
  const sessions = `${n} session${n === 1 ? '' : 's'}`;
  return { sample: s.sample, text: s.sample ? `${C.COPY.sample} · ${sessions}` : sessions };
}

// ------------------------------------------------------------------ the room

function dealtCards(s: PlayState, r: Room): { hand: Card[]; unavailable: { card: Card; reasons: string[] }[] } {
  const dr = draftRoom(s, r);
  const w = s.wording[r.key];
  const drafts = draftCards(dr, w !== undefined ? { wording: w } : {});
  if (dr.kind === 'workshop') return { hand: drafts, unavailable: [] };
  const heads = roomCases(s, dr).filter((c) => c.disposition === 'issue');
  const hand: Card[] = [];
  const unavailable: { card: Card; reasons: string[] }[] = [];
  for (const d of drafts) {
    const pv = previewDrop(s.deck, d, heads, 'beast');
    if (pv.eligible.length > 0) hand.push(d);
    else {
      const reasons = [...new Set(heads.map((h) => ineligibility(d.responseKey, h.observed) ?? (pv.heads.find((x) => x.caseId === h.id)?.preview.failing ? C.failWord(pv.heads.find((x) => x.caseId === h.id)!.preview.failing!.check, pv.heads.find((x) => x.caseId === h.id)!.preview.failing!.tri, { agent: h.agent, project: h.projectLabel }) : 'not eligible')))];
      unavailable.push({ card: d, reasons: heads.length ? reasons : ['no head is stamped a problem yet'] });
    }
  }
  return { hand, unavailable };
}

/** Imported lines whose suggested mapping passes checks 3–7 for a bared head: "Already in your file. Does it answer this case?" */
function existingAsks(s: PlayState, heads: Case[]): C.RoomView['existingAsks'] {
  const out: C.RoomView['existingAsks'] = [];
  const ex = exportOf(s.deck);
  for (const c of presentCards(s.deck)) {
    if (c.family !== 'imported') continue;
    const m = suggestMapping(c.text);
    if (m.responseKey === 'unmapped') continue;
    const k: Card = { ...c, mappingSuggested: false, trigger: m.trigger, responseKey: m.responseKey };
    for (const h of heads) if (h.disposition === 'issue' && !cover(c, h, ex).covers && coverPreview(k, h, ex, c.targets).eligible) out.push({ cardId: c.id, caseId: h.id, line: c.text });
  }
  return out;
}

export function selectRoom(s: PlayState, roomKey?: string): C.RoomView | null {
  const r = roomKey ? roomByKey(s, roomKey) : currentRoom(s);
  if (!r) return null;
  const p = progressOf(s, r.key);
  const heads = headViews(s, r);
  const cases = roomCases(s, draftRoom(s, r));
  const queue = heads.filter((h) => h.state === 'wrapped').map((h) => h.caseId);
  const currentId = p.receipt ?? queue[0] ?? heads[0]?.caseId ?? null;
  const current = currentId ? heads.find((h) => h.caseId === currentId)?.receipt ?? null : null;
  const { hand, unavailable } = dealtCards(s, r);
  const issues = cases.filter((c) => c.disposition === 'issue');
  const judged = cases.filter((c) => c.disposition !== 'unreviewed');
  const allAside = judged.length > 0 && judged.length === cases.length && issues.length === 0 && cases.every((c) => c.disposition !== 'unclear');
  const ex = exportOf(s.deck);
  const imported = presentCards(s.deck).filter((c) => c.family === 'imported');
  const keepExisting = issues.length > 0 && issues.every((h) => imported.some((k) => cover(k, h, ex).covers));
  const ctxHeads = cases;
  return {
    kind: r.kind === 'event' && dispOf(s, r.anchor.id) !== 'issue' ? 'event' : r.kind === 'workshop' ? 'workshop' : r.kind === 'event' ? 'encounter' : r.kind,
    roomKey: r.key,
    beast: beast(s, r, heads),
    heads,
    receipts: { current, queue },
    phase: p.phase,
    hand: p.phase === 'dealt' ? hand.map((c) => cardView(s, c, { room: draftRoom(s, r), heads: ctxHeads })) : [],
    unavailable: unavailable.map((u) => cardView(s, u.card, { room: draftRoom(s, r), heads: ctxHeads, unavailable: u.reasons })),
    books: selectBooks(s),
    piles: selectPiles(s),
    route: selectRoute(s),
    status: selectStatus(s),
    finalizes: p.phase === 'dealt' ? C.COPY.finalizes : null,
    canDeal: p.phase === 'judge' && (r.kind === 'workshop' || issues.length > 0) && hand.length > 0,
    offer: p.phase !== 'done' && allAside ? 'continue-all-set-aside' : p.phase !== 'done' && keepExisting ? 'keep-existing' : null,
    existingAsks: p.phase === 'done' ? [] : existingAsks(s, cases),
    result: p.result,
  };
}

// ------------------------------------------------------------------ room acts

function setProgress(s: PlayState, key: string, p: Partial<RoomProgress>): PlayState {
  return upd(s, { progress: Object.freeze({ ...s.progress, [key]: { ...progressOf(s, key), ...p } }) });
}

/** Stamp one head. Allowed while judging only; a dealt hand must be pulled back first; a finished room is final. */
export function actStamp(s: PlayState, caseId: string, stamp: C.Stamp): PlayState {
  const r = roomOfCase(s, caseId);
  if (!r || r.withheld.some((e) => e.id === caseId)) return s;
  if (progressOf(s, r.key).phase !== 'judge' || r.kind === 'workshop') return s;
  const next = upd(s, { disp: Object.freeze({ ...s.disp, [caseId]: stamp }) });
  // Immediate advance: the stage shows the next unstamped head.
  const queue = headEpisodes(r).filter((e) => dispOf(next, e.id) === 'unreviewed').map((e) => e.id);
  return setProgress(next, r.key, { receipt: queue[0] ?? caseId });
}

/** Put one head's receipt on the stage (the player may pick any head). */
export function actFocusReceipt(s: PlayState, caseId: string): PlayState {
  const r = roomOfCase(s, caseId);
  return r ? setProgress(s, r.key, { receipt: caseId }) : s;
}

/** Deal the hand: reversible until a play or skip (§0a.13). */
export function actDeal(s: PlayState): PlayState {
  const r = currentRoom(s);
  if (!r) return s;
  const v = selectRoom(s, r.key);
  return v && v.canDeal ? setProgress(s, r.key, { phase: 'dealt' }) : s;
}

/** Pull the hand back to change a stamp. */
export function actPullBack(s: PlayState): PlayState {
  const r = currentRoom(s);
  return r && progressOf(s, r.key).phase === 'dealt' ? setProgress(s, r.key, { phase: 'judge' }) : s;
}

function headsInDateOrder(s: PlayState, r: Room, ids: string[]): string[] {
  const eps = headEpisodes(r).filter((e) => ids.includes(e.id));
  return eps.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? '')).map((e) => e.id);
}

/**
 * Play a dealt card on the beast or a book. FINALIZES the room on success. The engine adds the card for the final
 * targets, accepts only glowing heads, then cover() decides; the result lists exactly the heads to animate.
 * A refused beast drop returns the state unchanged with the reason; the pick is not spent.
 */
export function actPlay(s: PlayState, cardId: string, target: DropTarget): { state: PlayState; result: C.PlayResultView } {
  const r = currentRoom(s);
  const refuse = (why: string) => ({ state: s, result: { played: false, skipped: false, refused: why, cardId, bound: [], standing: [], accepted: [], ink: [], finalized: false } });
  if (!r) return refuse('No room is open.');
  const p = progressOf(s, r.key);
  if (p.phase !== 'dealt') return refuse('Deal the hand first.');
  const { hand } = dealtCards(s, r);
  const card = hand.find((c) => c.id === cardId);
  if (!card) return refuse('That card is not in this hand.');
  const dr = draftRoom(s, r);
  const cases = roomCases(s, dr);
  let deck: DeckState;
  let accepted: string[] = [];
  let bound: string[] = [];
  if (dr.kind === 'workshop') {
    // A verified workflow is a success: the card joins the proposal and no case is accepted or counted.
    deck = withProposed(s.deck, card, target === 'beast' ? card.targets : target);
  } else {
    const res = playCard(s.deck, card, cases, target);
    if (res.refused) return refuse(res.refused);
    deck = res.deck;
    accepted = res.accepted;
    bound = headsInDateOrder(s, r, res.results.filter((x) => x.bound).map((x) => x.caseId));
  }
  const issues = cases.filter((c) => c.disposition === 'issue').map((c) => c.id);
  const ex = exportOf(deck);
  const played = presentCards(deck).find((c) => c.id === cardId)!;
  const result: C.PlayResultView = {
    played: true,
    skipped: false,
    refused: null,
    cardId,
    bound,
    standing: headsInDateOrder(s, r, issues.filter((id) => !bound.includes(id))),
    accepted,
    ink: AGENTS.filter((a) => ex[a].has(cardId)).map((a) => ({ file: C.FILE_OF[a], line: played.text })),
    finalized: true,
  };
  const shelf = [...s.shelf, ...hand.filter((c) => c.id !== cardId && !s.shelf.some((x) => x.id === c.id))];
  return { state: setProgress(upd(s, { deck, shelf: Object.freeze(shelf) }), r.key, { phase: 'done', result }), result };
}

/** Skip: the hand goes to the shelf, free. FINALIZES the room. A drop on the shelf is the same act. */
export function actSkip(s: PlayState): { state: PlayState; result: C.PlayResultView } {
  const r = currentRoom(s);
  const empty: C.PlayResultView = { played: false, skipped: true, refused: null, cardId: null, bound: [], standing: [], accepted: [], ink: [], finalized: true };
  if (!r) return { state: s, result: { ...empty, finalized: false, refused: 'No room is open.' } };
  const dr = draftRoom(s, r);
  const { hand } = dealtCards(s, r);
  const dealt = progressOf(s, r.key).phase === 'dealt' ? hand : [];
  const cases = roomCases(s, dr);
  const res = headResults(s.deck, cases, null);
  const result: C.PlayResultView = { ...empty, bound: headsInDateOrder(s, r, res.filter((x) => x.bound).map((x) => x.caseId)), standing: headsInDateOrder(s, r, cases.filter((c) => c.disposition === 'issue' && !res.find((x) => x.caseId === c.id)!.bound).map((c) => c.id)) };
  const shelf = [...s.shelf, ...dealt.filter((c) => !s.shelf.some((x) => x.id === c.id))];
  return { state: setProgress(upd(s, { shelf: Object.freeze(shelf) }), r.key, { phase: 'done', result }), result };
}

/** "Already in your file. Does it answer this case?" Yes: accept the line's mapping, then this case for it. */
export function actAnswerExisting(s: PlayState, cardId: string, caseId: string, yes: boolean): PlayState {
  if (!yes) return s;
  const r = roomOfCase(s, caseId);
  if (!r) return s;
  const c = roomCases(s, draftRoom(s, r)).find((x) => x.id === caseId);
  if (!c || c.disposition !== 'issue') return s;
  const d1 = acceptImportMapping(s.deck, cardId);
  const res = acceptOnHead(d1, cardId, c);
  return res.preview?.eligible ? upd(s, { deck: res.deck }) : s;
}

/** A card already in the proposal dropped on a standing head: accept that head when checks 1 and 3–7 hold (§3). */
export function actAcceptOnHead(s: PlayState, cardId: string, caseId: string): PlayState {
  const r = roomOfCase(s, caseId);
  if (!r) return s;
  const c = [...roomCases(s, draftRoom(s, r)), ...withheldCases(s, r)].find((x) => x.id === caseId);
  if (!c) return s;
  const res = acceptOnHead(s.deck, cardId, c);
  return res.preview?.eligible ? upd(s, { deck: res.deck }) : s;
}

/** The player's wording of the line (boundary and directive rooms), before dealing. */
export function actWording(s: PlayState, roomKey: string, text: string): PlayState {
  return upd(s, { wording: Object.freeze({ ...s.wording, [roomKey]: text }) });
}

/** Leave the node. A room must be finished (played or skipped) unless the offer says Continue. */
export function actAdvance(s: PlayState): PlayState {
  const n = currentNode(s);
  if (!n) return s;
  const r = currentRoom(s);
  if (r && (n.kind === 'encounter' || n.kind === 'elite' || n.kind === 'review' || n.kind === 'workshop' || n.kind === 'event')) {
    const v = selectRoom(s, r.key)!;
    const settled = progressOf(s, r.key).phase === 'done' || v.offer !== null || (r.kind === 'event' && ['pivot', 'not-a-problem', 'unclear'].includes(dispOf(s, r.anchor.id)));
    if (!settled) return s;
    if (progressOf(s, r.key).phase !== 'done') s = setProgress(s, r.key, { phase: 'done' });
    if (n.rooms.length > 1 && s.sub < n.rooms.length - 1) return upd(s, { sub: s.sub + 1 });
  }
  if (n.kind === 'boss' || n.kind === 'audit') s = actLockScore(s);
  return upd(s, { node: Math.min(s.node + 1, s.route.length - 1), sub: 0 });
}

/** Re-split a room by a confirmed project and rebuild the route (kept from the slice; §1 confirmed project). */
export function actRebuildRoute(s: PlayState, rooms: Room[]): PlayState {
  return upd(s, { rooms, route: buildRoute(rooms, { importedCards: s.deck.imported.length }).nodes });
}

// ------------------------------------------------------------------ drag previews

function heads(s: PlayState): Case[] {
  const r = currentRoom(s);
  return r ? roomCases(s, draftRoom(s, r)) : [];
}

function lineOf(c: Card, files: Agent[]): C.DragPreview['line'] {
  return { text: c.text, scope: c.scope.kind === 'global' ? 'all projects' : c.scope.label, exceptions: c.exceptions.map((e) => e.text), files: files.map((a) => C.FILE_OF[a]) };
}

/** The drag preview for one card over one target. Nothing binds here. */
export function selectDrag(s: PlayState, cardId: string, target: C.DragTarget): C.DragPreview {
  const none: C.DragPreview = { verb: 'none', heads: [], ghost: ZERO_GHOST(s), line: null, accepts: [], refused: null };
  const n = currentNode(s);
  const r = currentRoom(s);
  const present = presentCards(s.deck);
  if (r && n && n.kind !== 'campfire' && n.kind !== 'boss' && n.kind !== 'audit') {
    const hand = dealtCards(s, r).hand;
    const card = hand.find((c) => c.id === cardId);
    const hs = heads(s);
    if (target.kind === 'shelf') return { ...none, verb: 'skip', heads: hs.map((h) => ({ caseId: h.id, glow: false, word: null })) };
    if (card && (target.kind === 'beast' || target.kind === 'book')) {
      const t: DropTarget = target.kind === 'beast' ? 'beast' : target.lane;
      const pv = previewDrop(s.deck, card, hs, t);
      return {
        verb: target.kind === 'beast' ? 'play' : 'add',
        heads: pv.heads.map((h) => {
          const c = hs.find((x) => x.id === h.caseId)!;
          return { caseId: h.caseId, glow: h.preview.eligible, word: h.preview.failing ? C.failWord(h.preview.failing.check, h.preview.failing.tri, { agent: c.agent, project: c.projectLabel }, target.kind === 'book' ? target.lane : undefined) : null };
        }),
        ghost: ghosts(pv.weight),
        line: lineOf(card, pv.destinations),
        accepts: pv.refused ? [] : pv.eligible,
        refused: pv.refused,
      };
    }
    const inDeck = present.find((c) => c.id === cardId);
    if (inDeck && target.kind === 'head') {
      const c = [...hs, ...withheldCases(s, r)].find((x) => x.id === target.caseId);
      if (!c) return none;
      const pv = coverPreview(inDeck, c, exportOf(s.deck), inDeck.targets);
      return { ...none, verb: 'accept', heads: [{ caseId: c.id, glow: pv.eligible, word: pv.failing ? C.failWord(pv.failing.check, pv.failing.tri, { agent: c.agent, project: c.projectLabel }) : null }], line: lineOf(inDeck, AGENTS.filter((a) => exportOf(s.deck)[a].has(inDeck.id))), accepts: pv.eligible ? [c.id] : [] };
    }
    return none;
  }
  if (n?.kind === 'campfire') return campfireDrag(s, cardId, target, none);
  if (n?.kind === 'boss' || n?.kind === 'audit') {
    if (target.kind !== 'head') return none;
    const b = selectBoss(s);
    const cand = b.current === target.caseId ? b.candidates.find((c) => c.cardId === cardId) : undefined;
    const card = present.find((c) => c.id === cardId);
    if (!cand || !card) return none;
    return { ...none, verb: 'answer', heads: [{ caseId: target.caseId, glow: cand.glow, word: cand.reason }], line: lineOf(card, AGENTS.filter((a) => exportOf(s.deck)[a].has(card.id))), accepts: cand.glow ? [target.caseId] : [] };
  }
  return none;
}

// ------------------------------------------------------------------ campfire

function threadsOf(s: PlayState): { gold: FuseSuggestion[]; red: Conflict[] } {
  return { gold: fuseSuggestions(s.deck), red: conflicts(s.deck) };
}

export function selectCampfire(s: PlayState): C.CampfireView {
  const present = presentCards(s.deck).filter((c) => c.type !== 'trait');
  const lanes: Record<C.LaneTab, C.CardView[]> = { claude: [], both: [], codex: [] };
  for (const c of present) lanes[c.targets].push(cardView(s, c));
  const { gold, red } = threadsOf(s);
  /** Honesty map: gold thread = fuseSuggestions kind and `why`; red thread = opposed() between two present cards (§13). */
  const threads: C.ThreadView[] = [
    ...red.map((c) => ({ id: c.id, color: 'red' as const, members: [c.a, c.b], reason: c.text, autoText: null })),
    ...gold.map((g) => ({ id: g.id, color: 'gold' as const, members: g.members, reason: g.why, autoText: g.autoText })),
  ];
  const books = selectBooks(s);
  const over = books.some((b) => b.weight.over);
  const focus = s.campfire.focus ?? (threads[0] ? { a: threads[0].members[0]!, b: threads[0].members[1]!, threadId: threads[0].id } : null);
  const piles = selectPiles(s);
  const projects = [...new Map(placedRooms(s).flatMap((r) => r.projects).filter((p): p is { key: string; label: string | null } => !!p.key).map((p) => [p.key, p.label ?? 'this project'] as const)).entries()].map(([key, label]) => ({ key, label }));
  return {
    tab: s.campfire.tab,
    projects,
    lanes,
    focusedPair: focus,
    threads,
    books,
    piles,
    ash: s.ash.map((c) => cardView(s, c)),
    pinned: s.campfire.pinned ? piles.open.find((p) => p.caseId === s.campfire.pinned) ?? null : null,
    coach: over ? 'A file is over its allowance. Apply waits until it fits: merge, shorten, cut, or move a procedure into a Skill.' : null,
    route: selectRoute(s),
    status: selectStatus(s),
  };
}

/** Honesty map: fuse / cut / sharpen preview = real per-file deltas; cases = coverage() before and after (§13, §0a.9). */
function changeView(s: PlayState, after: DeckState, p: Preview, lines: C.ChangePreviewView['lines'] = []): C.ChangePreviewView {
  const reviewed = reviewedCases(s);
  const ex = exportOf(after);
  // A new text binds nothing until accepted: the opened cases a fused or edited card would still be eligible for.
  const needsAcceptance = p.cases.opened.filter((id) => {
    const c = reviewed.find((x) => x.id === id);
    return !!c && presentCards(after).some((k) => coverPreview(k, c, ex, k.targets).eligible);
  });
  const affected = p.cases.opened.length + p.cases.addressed.length;
  return {
    before: p.before.map((b) => ({ id: b.id, text: b.text })),
    after: p.after ? { text: p.after.text, targets: p.after.targets, scope: p.after.scope.kind === 'global' ? 'all projects' : p.after.scope.label, exceptions: p.after.exceptions.map((e) => e.text) } : null,
    lines,
    ghost: ghosts(weightPreview(s.deck, after)),
    cases: { affected, deckBefore: p.cases.before, deckAfter: p.cases.after, opened: p.cases.opened, addressed: p.cases.addressed, text: C.casesText(affected, p.cases.before, p.cases.after) },
    needsAcceptance,
  };
}

/** The preview of a gold or red thread (with the player's text or chosen settlement), or of a cut. */
export function selectChangePreview(s: PlayState, q: { threadId: string; text?: string; resolution?: Resolution } | { cutId: string }): C.ChangePreviewView | null {
  const reviewed = reviewedCases(s);
  if ('cutId' in q) {
    const r = cutCard(s.deck, q.cutId, reviewed);
    return changeView(s, r.deck, r.preview);
  }
  const { gold, red } = threadsOf(s);
  const g = gold.find((x) => x.id === q.threadId);
  if (g) {
    const text = q.text ?? g.autoText;
    if (!text) return null;
    return changeView(s, applyFuse(s.deck, g, text), previewFuse(s.deck, g, text, reviewed));
  }
  const c = red.find((x) => x.id === q.threadId);
  if (c && q.resolution) {
    const pv = previewSettlement(s.deck, c, q.resolution, reviewed);
    return changeView(s, pv.after, pv.preview, pv.lines.map((l) => ({ id: l.id, text: l.text, files: l.files.map((a) => C.FILE_OF[a]) })));
  }
  return null;
}

function campfireDrag(s: PlayState, cardId: string, target: C.DragTarget, none: C.DragPreview): C.DragPreview {
  const present = presentCards(s.deck);
  const card = present.find((c) => c.id === cardId) ?? s.shelf.find((c) => c.id === cardId);
  if (!card) return none;
  if (target.kind === 'card') {
    const { gold, red } = threadsOf(s);
    const pair = (ids: string[]) => ids.includes(cardId) && ids.includes(target.cardId);
    const g = gold.find((x) => pair(x.members));
    if (g) {
      const v = g.autoText ? selectChangePreview(s, { threadId: g.id }) : null;
      return { ...none, verb: 'fuse', ghost: v ? v.ghost : none.ghost, line: g.autoText ? { text: g.autoText, scope: v?.after?.scope ?? '', exceptions: v?.after?.exceptions ?? [], files: [] } : null };
    }
    if (red.some((x) => pair([x.a, x.b]))) return { ...none, verb: 'settle' };
    if (s.shelf.some((x) => x.id === cardId) && present.some((x) => x.id === target.cardId)) {
      const after = actSwap(s, cardId, target.cardId);
      return after === s ? { ...none, refused: 'Swap only with a deck card of the same family.' } : { ...none, verb: 'swap', ghost: ghosts(weightPreview(s.deck, after.deck)) };
    }
    return { ...none, refused: 'These two cards neither stack nor disagree.' };
  }
  if (target.kind === 'fire') {
    const v = selectChangePreview(s, { cutId: cardId });
    return v ? { ...none, verb: 'cut', ghost: v.ghost } : none;
  }
  if (target.kind === 'book-retarget') {
    const g = s.deck.cards.find((x) => x.id === cardId);
    if (!g) return { ...none, refused: 'A line from your file stays in that file.' };
    const to: Targets = g.targets === target.lane ? target.lane : g.targets === 'both' ? target.lane : 'both';
    const res = retarget(s.deck, cardId, to);
    return { ...none, verb: to === 'both' ? 'widen' : 'narrow', ghost: ghosts(weightPreview(s.deck, res.deck)), line: lineOf(g, to === 'both' ? ['claude', 'codex'] : [to]) };
  }
  return none;
}

export function actTab(s: PlayState, tab: C.LaneTab): PlayState {
  return upd(s, { campfire: { ...s.campfire, tab } });
}

export function actFocusPair(s: PlayState, focus: { a: string; b: string; threadId: string | null } | null): PlayState {
  return upd(s, { campfire: { ...s.campfire, focus } });
}

/** Pin one Open receipt at the fire as a self-chosen puzzle (not a drop target). */
export function actPin(s: PlayState, caseId: string | null): PlayState {
  return upd(s, { campfire: { ...s.campfire, pinned: caseId } });
}

/** Seal a fuse with the shown text. */
export function actFuse(s: PlayState, threadId: string, text: string): PlayState {
  const g = threadsOf(s).gold.find((x) => x.id === threadId);
  if (!g || !text.trim()) return s;
  return upd(s, { deck: applyFuse(s.deck, g, text) });
}

/** Settle a red thread. Cancel leaves it (§0a.8). */
export function actSettle(s: PlayState, threadId: string, resolution: Resolution): PlayState {
  const c = threadsOf(s).red.find((x) => x.id === threadId);
  return c ? upd(s, { deck: resolveConflict(s.deck, c, resolution) }) : s;
}

/** Cut a card into the fire; it goes to the ash list, restorable until Apply. */
export function actCut(s: PlayState, cardId: string): PlayState {
  const card = presentCards(s.deck).find((c) => c.id === cardId);
  if (!card) return s;
  return upd(s, { deck: removeCard(s.deck, cardId), ash: Object.freeze([...s.ash, card]) });
}

/** Restore a cut card from the ash list. */
export function actRestore(s: PlayState, cardId: string): PlayState {
  const card = s.ash.find((c) => c.id === cardId);
  if (!card) return s;
  let d = s.deck;
  if (isProse(card)) d = withEdit(d, cardId, null);
  else if (d.removedManaged.includes(cardId)) d = Object.freeze({ ...d, removedManaged: Object.freeze(d.removedManaged.filter((x) => x !== cardId)) });
  else d = withCards(d, [...d.cards, card]);
  return upd(s, { deck: d, ash: Object.freeze(s.ash.filter((c) => c.id !== cardId)) });
}

/** Sharpen a card's text; its mappings must be accepted again. */
export function actSharpen(s: PlayState, cardId: string, text: string): PlayState {
  return upd(s, { deck: sharpen(s.deck, cardId, text) });
}

/** Re-target a card at the fire (a book drop): widen to both, or narrow a shared card to one book. */
export function actRetarget(s: PlayState, cardId: string, lane: Agent): PlayState {
  const g = s.deck.cards.find((x) => x.id === cardId);
  if (!g) return s;
  const to: Targets = g.targets === lane ? lane : g.targets === 'both' ? lane : 'both';
  const res = retarget(s.deck, cardId, to);
  return res.refused ? s : upd(s, { deck: res.deck });
}

/** Swap a shelf card for a deck card of the same family: the deck card goes to the shelf. */
export function actSwap(s: PlayState, shelfId: string, deckId: string): PlayState {
  const incoming = s.shelf.find((c) => c.id === shelfId);
  const outgoing = s.deck.cards.find((c) => c.id === deckId);
  if (!incoming || !outgoing || incoming.family !== outgoing.family) return s;
  const deck = withProposed(withCards(s.deck, s.deck.cards.filter((c) => c.id !== deckId)), incoming, outgoing.targets);
  return upd(s, { deck, shelf: Object.freeze([...s.shelf.filter((c) => c.id !== shelfId), Object.freeze({ ...outgoing, taken: false })]) });
}

/** Accept a card for one reviewed case from the inspector (check 8), when checks 1 and 3–7 hold. */
export function actAcceptMapping(s: PlayState, cardId: string, caseId: string): PlayState {
  return actAcceptOnHead(s, cardId, caseId);
}

/** Accept an imported line's suggested mapping for its current text. */
export function actAcceptImport(s: PlayState, cardId: string): PlayState {
  return upd(s, { deck: acceptImportMapping(s.deck, cardId) });
}

/** Raise a lane's allowance explicitly; printed on the end screen as "allowance raised to N by you". */
export function actRaiseAllowance(s: PlayState, lane: Agent, to: number): PlayState {
  return upd(s, { raised: { ...s.raised, [lane]: to } });
}

// ------------------------------------------------------------------ the boss

function bossItems(s: PlayState): { cases: Case[]; source: ('sealed' | 'open')[]; earlier: Case[] } {
  const n = currentNode(s);
  const rooms = (n?.kind === 'boss' ? n.rooms : []).map((k) => roomByKey(s, k)).filter((x): x is Room => !!x);
  const sealed = rooms.flatMap((r) => withheldCases(s, r)).sort((a, b) => (episodeOf(s, a.id)?.ts ?? '').localeCompare(episodeOf(s, b.id)?.ts ?? ''));
  const earlier = confirmedCases(s).filter((c) => !sealed.some((x) => x.id === c.id));
  const openIds = new Set(openPile(s.deck, earlier));
  const open = earlier.filter((c) => openIds.has(c.id));
  return { cases: [...sealed, ...open], source: [...sealed.map(() => 'sealed' as const), ...open.map(() => 'open' as const)], earlier };
}

/**
 * Honesty map: boss score = cover() over withheld cases stamped a problem, set-asides printed beside it, locked after
 * the last head and keyed to the deck revision; earlier = coverage() over the run's reviewed set against the final
 * deck; original = imported lines whose per-case mapping the player accepted / suggestions never judged (§13).
 */
export function selectBoss(s: PlayState): C.BossView {
  const n = currentNode(s);
  const { cases, source, earlier } = bossItems(s);
  const sealedCases = cases.filter((_, i) => source[i] === 'sealed');
  const t = s.boss.locked?.tally ?? bossTally(s.deck, sealedCases, earlier);
  const ex = exportOf(s.deck);
  const cards = presentCards(s.deck);
  const headsV: C.BossHeadView[] = cases.map((c, i) => ({ caseId: c.id, source: source[i]!, receipt: receiptOf(episodeOf(s, c.id)!), disposition: c.disposition, addressed: c.disposition === 'issue' && cards.some((k) => cover(k, c, ex).covers) }));
  const cur = cases[s.boss.index] ?? null;
  let candidates: C.BossCandidateView[] = [];
  let noEligible = false;
  if (cur && cur.disposition === 'issue') {
    const live = bossTally(s.deck, [cur], []).heads[0]!;
    const head = { agent: cur.agent, project: cur.projectLabel };
    candidates = live.candidates.map((c) => ({ cardId: c.cardId, glow: c.eligible, reason: c.failing ? C.bossReason(c.failing.check, c.failing.tri, head) : null }));
    noEligible = live.noEligibleCard;
  }
  const aside = t.setAside.notAProblem + t.setAside.changeOfPlan + t.setAside.unclear;
  const asideText = `${aside} set aside (${t.setAside.notAProblem} not a problem, ${t.setAside.changeOfPlan} a change of plan, ${t.setAside.unclear} unclear)`;
  const waiting = t.unreviewed > 0 ? ` · ${t.unreviewed} not yet stamped` : '';
  const lines = [
    sealedCases.length === 0
      ? 'No later cases were held back; no held-out claim is made.'
      : t.later.confirmed > 0
        ? `Later cases: ${t.later.addressed} of ${t.later.confirmed} addressed · ${asideText}${waiting}`
        : `Later cases: none confirmed a problem · ${asideText}${waiting}`,
    `Earlier open cases: ${t.earlier.addressed} of ${t.earlier.confirmed} now addressed`,
    t.original.established ? `Your current files: ${t.original.addressed} of ${t.original.confirmed} · ${t.original.unknown} unknown` : `${C.COPY.applicabilityUnknown} · ${t.original.unknown} unknown`,
  ];
  return {
    kind: n?.kind === 'audit' ? 'audit' : 'boss',
    heads: headsV,
    current: cur?.id ?? null,
    candidates,
    noEligibleCard: noEligible,
    score: { later: t.later, setAside: t.setAside, unreviewed: t.unreviewed, earlier: { addressed: t.earlier.addressed, confirmed: t.earlier.confirmed }, original: t.original, lines, locked: !!s.boss.locked, stale: !!s.boss.locked && !tallyCurrent(s.boss.locked, s.deck) },
    canContinue: true,
  };
}

/** The blind stamp at the boss: one click, locked (a stamped head is never re-stamped). */
export function actBossStamp(s: PlayState, caseId: string, stamp: C.Stamp): PlayState {
  const { cases, source } = bossItems(s);
  const i = cases.findIndex((c) => c.id === caseId);
  if (i < 0 || source[i] !== 'sealed' || dispOf(s, caseId) !== 'unreviewed') return s;
  return upd(s, { disp: Object.freeze({ ...s.disp, [caseId]: stamp }) });
}

/** The answer drag: accept an eligible deck card's mapping for the current head. No new cards, no edits. */
export function actBossAnswer(s: PlayState, cardId: string, caseId: string): PlayState {
  const { cases } = bossItems(s);
  const c = cases.find((x) => x.id === caseId);
  if (!c) return s;
  const res = answerBoss(s.deck, cardId, c);
  return res.deck === s.deck ? s : upd(s, { deck: res.deck });
}

/** Continue past the current head (an unmatched one stays open); after the last, lock the score. */
export function actBossNext(s: PlayState): PlayState {
  const { cases } = bossItems(s);
  const next = upd(s, { boss: { ...s.boss, index: Math.min(s.boss.index + 1, cases.length) } });
  return next.boss.index >= cases.length ? actLockScore(next) : next;
}

/** Lock the score to the current deck revision. Re-locking recomputes (Apply may send the player back, §0a.12). */
export function actLockScore(s: PlayState): PlayState {
  const { cases, source, earlier } = bossItems(s);
  const sealed = cases.filter((_, i) => source[i] === 'sealed');
  if (sealed.length === 0 && earlier.length === 0 && s.boss.locked) return s;
  const tally = bossTally(s.deck, sealed, earlier);
  return upd(s, { boss: { ...s.boss, locked: { revision: tally.revision, tally } } });
}

// ------------------------------------------------------------------ Apply (through a port; the write protocol is the engine's)

/** What the adapter needs from the folders the player granted. The integrator implements it over the slice's roots. */
export interface ApplyPort {
  /** The roots Apply writes through, or null while a folder is missing. */
  roots(): Root[] | null;
  /** Folders still to grant before a diff can be shown or a Skill written for Codex. */
  needs(): { claude: boolean; codex: boolean; agents: boolean };
  /** Read a file from a skill root (the legacy Codex root is read-only), null when absent. */
  readSkill(root: 'claude-skills' | 'codex-skills' | 'codex-legacy-skills', rel: string): Promise<Uint8Array | null>;
  /** Ask for write access at the seal; false when refused. */
  ensureWritable(): Promise<boolean>;
}

export async function actPrepareApply(s: PlayState, port: ApplyPort): Promise<PlayState> {
  try {
    const roots = port.roots();
    if (!roots) return upd(s, { apply: { ...s.apply, targets: null, plan: null, error: null } });
    const t = await applyTargets(s.deck, [...s.rooms], { claude: true, codex: !port.needs().agents }, (root, rel) => port.readSkill(root, rel));
    const plan = t.problems.length ? null : await makePlan(roots, t.targets);
    return upd(s, { apply: { targets: t, plan, result: null, undo: null, error: null } });
  } catch (e) {
    return upd(s, { apply: { ...s.apply, error: String((e as Error)?.message ?? e) } });
  }
}

/** Seal: the engine's guarded write with byte-exact backups and read-back. Blocked while selectApply says so. */
export async function actSeal(s: PlayState, port: ApplyPort): Promise<PlayState> {
  const v = selectApply(s, port);
  const roots = port.roots();
  if (!v.canSeal || !s.apply.plan || !roots) return s;
  if (!(await port.ensureWritable())) return upd(s, { apply: { ...s.apply, error: 'Write access was not granted.' } });
  const result = await applyPlan(s.apply.plan, roots, s.apply.plan.digest);
  return upd(s, { apply: { ...s.apply, result, error: null } });
}

export async function actUndo(s: PlayState, port: ApplyPort): Promise<PlayState> {
  const r = s.apply.result;
  const id = r?.status === 'written' ? r.receipt.bundleId : r?.status === 'partial' ? r.bundleId : null;
  const roots = port.roots();
  if (!id || !roots) return s;
  return upd(s, { apply: { ...s.apply, undo: await undoBundle(id, roots) } });
}

/** "Return to the final campfire" with the blocker selected; judgments are kept, the score is recomputed on return. */
export function actReturnToCampfire(s: PlayState, select: { lane?: Agent; threadId?: string } | null): PlayState {
  let idx = -1;
  s.route.forEach((n, i) => {
    if (n.kind === 'campfire') idx = i;
  });
  if (idx < 0) return s;
  const red = select?.threadId ? threadsOf(s).red.find((c) => c.id === select.threadId) : undefined;
  return upd(s, { node: idx, sub: 0, campfire: { ...s.campfire, tab: select?.lane ?? s.campfire.tab, focus: red ? { a: red.a, b: red.b, threadId: red.id } : s.campfire.focus }, apply: { targets: null, plan: null, result: null, undo: null, error: null } });
}

/** Honesty map: stamps = Reviewed (every selected case has a disposition), Fits (both within allowance), Written (every read-back matched) (§13). */
export function selectApply(s: PlayState, port?: Pick<ApplyPort, 'needs'>): C.ApplyView {
  const t = s.apply.targets;
  const needs = port ? port.needs() : { claude: false, codex: false, agents: false };
  const diffs: C.ApplyDiffView[] = [];
  if (t) {
    for (const sk of t.skills) diffs.push({ label: sk.slug, path: sk.rel, ops: lineDiff('', sk.text), weight: null, problem: sk.problems.join(' ') || null, blocker: null, kind: 'skill' });
    for (const l of [t.lanes.claude, t.lanes.codex]) diffs.push({ label: l.lane.rel, path: l.lane.label, ops: lineDiff(utf8(l.original ?? new Uint8Array(0)), utf8(l.next)), weight: { before: l.before.total, after: l.after.total, allowance: l.allowance }, problem: l.problem, blocker: l.blocker, kind: 'global' });
  }
  const blockers: C.ApplyBlockerView[] = [];
  const L = renderLanes(s.deck, s.raised);
  for (const a of AGENTS) if (L[a].after.total > L[a].allowance) blockers.push({ kind: 'clasp', text: `${C.FILE_OF[a]} weighs ${L[a].after.total} of ${L[a].allowance} (estimated).`, select: { lane: a } });
  for (const c of conflicts(s.deck)) blockers.push({ kind: 'conflict', text: c.text, select: { threadId: c.id } });
  if (needs.claude || needs.codex) blockers.push({ kind: 'grant', text: 'Choose the folders that hold your two files to see the diff.', select: null });
  if (t) for (const p of t.problems) blockers.push({ kind: 'lane', text: p, select: null });
  if (s.apply.result?.status === 'stale') blockers.push({ kind: 'stale', text: `Changed since the diff: ${s.apply.result.changed.map((c) => c.rel).join(', ')}.`, select: null });
  const r = s.apply.result;
  const selected = placedRooms(s).filter((x) => x.kind !== 'workshop').flatMap((x) => x.episodes);
  const reviewedAll = selected.every((e) => dispOf(s, e.id) !== 'unreviewed');
  const fits = AGENTS.every((a) => L[a].after.total <= L[a].allowance);
  const ink = (ok: boolean): C.InkState => (r ? (ok ? 'inked' : 'failed') : 'pending');
  const written = r?.status === 'written' || r?.status === 'unchanged';
  const resultText = !r
    ? null
    : r.status === 'written'
      ? { status: r.status, text: 'Written and read back.', bundle: r.receipt.bundleId }
      : r.status === 'unchanged'
        ? { status: r.status, text: 'The files already say exactly this. Nothing was written.', bundle: null }
        : r.status === 'stale'
          ? { status: r.status, text: 'Stopped before writing: a file changed since the diff.', bundle: null }
          : r.status === 'rejected'
            ? { status: r.status, text: r.reason, bundle: null }
            : r.status === 'backup-failed'
              ? { status: r.status, text: `The recovery copy could not be verified: ${r.error}. Nothing was written.`, bundle: null }
              : { status: r.status, text: `${r.failed.rel}: ${r.failed.error}`, bundle: r.bundleId };
  const u = s.apply.undo;
  return {
    needs,
    diffs,
    notes: t?.notes ?? [],
    blockers,
    canSeal: !!s.apply.plan && blockers.length === 0 && !written,
    stamps: { reviewed: ink(reviewedAll), fits: ink(fits), written: ink(written) },
    result: resultText as C.ApplyView['result'],
    undo: u
      ? u.status === 'refused'
        ? { status: 'refused', files: [], text: u.reason }
        : { status: 'done', files: u.files.map((f) => ({ path: f.rel, text: f.status === 'restored' ? 'restored to the original bytes' : f.status === 'already-original' ? 'already the original' : f.status === 'conflict' ? 'changed after Apply; nothing was overwritten' : `failed: ${f.error}`, conflict: f.status === 'conflict' })), text: null }
      : null,
    footer: C.COPY.footer,
  };
}

// ------------------------------------------------------------------ the screen

/** Which screen the controller shows for the current node. */
export function selectScreen(s: PlayState, port?: Pick<ApplyPort, 'needs'>): C.Screen {
  const n = currentNode(s);
  if (!n) return { kind: 'empty', text: 'No route: not enough evidence for a room yet.' };
  switch (n.kind) {
    case 'campfire':
      return { kind: 'campfire', view: selectCampfire(s) };
    case 'boss':
    case 'audit':
      return { kind: 'boss', view: selectBoss(s) };
    case 'apply':
      return { kind: 'apply', view: selectApply(s, port) };
    case 'card-review':
      return { kind: 'empty', text: 'Your existing rules: each line has a suggested mapping; accept it from the inspector at a campfire.' };
    default: {
      const v = selectRoom(s);
      if (!v) return { kind: 'empty', text: 'Room not found.' };
      return v.kind === 'event' ? { kind: 'event', view: v } : { kind: 'room', view: v };
    }
  }
}
