// Episode grouping (spec §2), the boss withholding and the eight-node linear route (spec §1).
// Rooms group by family + object/workflow + project. Support is counted in distinct sessions.
// Repeated commands and rewrites are project-bound (their object lives in one tree); stops, directives and workflows
// group across projects because they describe how the person works, and the room lists every project it saw.
// The player can confirm one project for a room (splitByProject), which is the "confirmed project" part of the key.

import type { Agent, Session } from './model';
import type { DirectiveEpisode, Episode, InterruptEpisode, WorkflowEpisode } from './episodes';
import { contentTokens, isPasted, jaccard, narrowedRerun, relPath } from './episodes';
import { isFocusedTest, isTestCommand } from './noise';
import { commandPrefixOf, fingerprint } from './parse/common';
import type { Case, CaseFacts, Disposition, Family } from './deck/types';
import { FAMILY_KEYS } from './deck/types';
import { opposed, suggestClaims } from './deck/claims';

export const NEAR_DUPLICATE = 0.72;
/** Up to this many later distinct-session cases are withheld for the boss. */
export const MAX_WITHHELD = 3;
/** A room keeps at least this many sessions before anything is withheld. */
export const MIN_IN_ROOM = 3;

export type RoomKind = 'encounter' | 'event' | 'workshop';

export interface RoomObject {
  /** 'cmd:pytest', 'path:pyramid/tests/', 'text:<cluster key>', 'file:<path>', 'workflow:<key>', 'ep:<id>'. */
  key: string;
  /** What the player reads: the command, the directory, the file, or the instruction. */
  label: string;
  /** The exact value a trigger matches (command prefix or path). Defaults to label. */
  match?: string;
  kind: 'command' | 'path' | 'file' | 'text' | 'workflow' | 'none';
}

export interface Room {
  /** Stable key: family|object|project ('*' when the room spans projects). */
  key: string;
  family: Family;
  kind: RoomKind;
  object: RoomObject;
  /** The one project every case in the room (withheld included) shares, else null. */
  projectKey: string | null;
  projectLabel: string | null;
  projects: { key: string | null; label: string | null }[];
  agents: Agent[];
  /** In-room episodes, oldest first. */
  episodes: Episode[];
  /** Later distinct-session cases kept back for the boss. */
  withheld: Episode[];
  anchor: Episode;
  /** Distinct sessions in the room (withheld excluded) and in total. */
  sessions: number;
  totalSessions: number;
  name: string;
  subtitle: string;
  /** Stop families: a constraint phrase proposed from the anchor's own words. The player edits and confirms it. */
  proposedConstraint: string | null;
  /** Directive rooms built from stops: the follow-up narrowed a whole test run to a focused one. */
  narrowedTests: boolean;
  /** The grouping this room came from (kept so a confirmed project can split it). */
  readonly group: Readonly<Group>;
}

// ------------------------------------------------------------------ helpers

function tsOf(e: Episode): number {
  const t = e.ts ? Date.parse(e.ts) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** How readable an anchor is: typed human words first, tool evidence next, pasted text last. */
export function anchorScore(e: Episode): number {
  if (e.type === 'interrupt') return e.receipt.quote ? (e.pasted ? 1 : 3) : 0;
  if (e.type === 'directive') return 3;
  if (e.type === 'edit-sequence' && e.receipt.quote) return 3;
  return 2;
}

/** The object an interrupt cut off: a command prefix, or the directory of an edited file. */
export function interruptObject(e: InterruptEpisode, cwd: string | null): RoomObject | null {
  const c = e.interruptedCall;
  if (!c) return null;
  if (c.kind === 'shell' && c.command) {
    const prefix = commandPrefixOf(fingerprint(c.command));
    if (prefix) return { key: `cmd:${prefix}`, label: prefix, kind: 'command' };
  }
  if (c.kind === 'edit' && c.files.length) {
    const rel = relPath(c.files[0]!, cwd);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : rel;
    return { key: `path:${dir}`, label: dir, kind: 'path' };
  }
  return null;
}

/** Clauses of a message that state a line (negation, only, instead, always…), in the person's own words. */
export function proposeConstraint(text: string): string {
  const clauses = text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((c) => c.trim())
    .filter((c) => c.split(/\s+/).length >= 2);
  const marked = clauses.filter((c) => /\b(?:never|don'?t|dont|do not|not|no|only|stop|avoid|without|instead|always|must|keep|leave)\b/i.test(c));
  const pick = (marked.length ? marked : clauses.slice(0, 1)).map((c) => c.charAt(0).toUpperCase() + c.slice(1));
  let out = pick.join(' ').replace(/\s+/g, ' ').trim();
  if (out && !/[.!?]$/.test(out)) out += '.';
  return out.length > 220 ? out.slice(0, 219).replace(/\s+\S*$/, '') + '…' : out;
}

// ------------------------------------------------------------------ type 4 clustering

/**
 * Cluster directive candidates across sessions: exact-normalised equality or content-token Jaccard ≥ 0.72.
 * Returns clusters that span at least two distinct sessions. The cluster key is the earliest member's norm.
 */
const claimCache = new WeakMap<DirectiveEpisode, ReturnType<typeof suggestClaims>>();
function claimsOf(d: DirectiveEpisode) {
  let c = claimCache.get(d);
  if (!c) claimCache.set(d, (c = suggestClaims(d.text)));
  return c;
}

export function clusterDirectives(cands: DirectiveEpisode[]): DirectiveEpisode[][] {
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i]!;
      const b = cands[j]!;
      if (a.sessionId === b.sessionId) continue;
      if (!(a.norm === b.norm || jaccard(a.tokens, b.tokens) >= NEAR_DUPLICATE)) continue;
      // The same words can carry opposite instructions ("npm instead of bun" / "bun instead of npm"): never one cluster.
      const ca = claimsOf(a);
      const cb = claimsOf(b);
      if (ca.some((x) => cb.some((y) => opposed(x, y)))) continue;
      parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, DirectiveEpisode[]>();
  cands.forEach((c, i) => {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(c);
    groups.set(r, g);
  });
  return [...groups.values()].filter((g) => new Set(g.map((e) => e.sessionId)).size >= 2).map((g) => [...g].sort((a, b) => tsOf(a) - tsOf(b)));
}

// ------------------------------------------------------------------ rooms

export interface Group {
  family: Family | 'stop';
  kind: RoomKind;
  object: RoomObject;
  projectBound: boolean;
  episodes: Episode[];
  /** Directive cluster key for text-built directive rooms. */
  clusterKey?: string;
}

const NAMES: Record<Family | 'event', string> = {
  'repeated-command': 'The unchanged retry',
  rewrite: 'The rewrite',
  boundary: 'The stop',
  directive: 'The standing order',
  workflow: 'The workshop',
  event: 'A change of plan',
};

function times(n: number, sessions: number): string {
  return `${n} time${n === 1 ? '' : 's'} in ${sessions} session${sessions === 1 ? '' : 's'}`;
}

export function buildRooms(sessions: Session[], episodes: Episode[]): Room[] {
  const cwdOf = new Map(sessions.map((s) => [s.id, s.cwd]));
  const groups = new Map<string, Group>();
  const add = (key: string, init: Omit<Group, 'episodes'>, e: Episode) => {
    const g = groups.get(key) ?? { ...init, episodes: [] };
    g.episodes.push(e);
    groups.set(key, g);
  };
  const interrupts = episodes.filter((e): e is InterruptEpisode => e.type === 'interrupt' && e.humanTurn !== null);
  const byHuman = new Map(interrupts.map((e) => [`${e.sessionId}#${e.humanTurn}`, e]));

  // 1. Repeated directives (type 4). A member that answered an interrupt brings its interrupt episode (the receipt
  //    keeps the cut-off action); that interrupt then belongs here, not to a stop room.
  const consumed = new Set<string>();
  // A message that answered a stop as a change of plan stays a neutral event; it never feeds a directive.
  const pivotTurns = new Set(interrupts.filter((e) => e.reply === 'pivot').map((e) => `${e.sessionId}#${e.humanTurn}`));
  const cands = episodes.filter((e): e is DirectiveEpisode => e.type === 'directive' && !pivotTurns.has(`${e.sessionId}#${e.humanTurn}`));
  for (const cluster of clusterDirectives(cands)) {
    const key = cluster[0]!.norm;
    const perSession = new Map<string, DirectiveEpisode>();
    for (const d of cluster) if (!perSession.has(d.sessionId)) perSession.set(d.sessionId, d);
    for (const d of perSession.values()) {
      const ie = byHuman.get(`${d.sessionId}#${d.humanTurn}`);
      const e: Episode = ie ?? d;
      if (ie) consumed.add(ie.id);
      add(`directive|text:${key}`, { family: 'directive', kind: 'encounter', object: { key: `text:${key}`, label: cluster[0]!.text, kind: 'text' }, projectBound: false, clusterKey: key }, e);
    }
  }

  // A stop that promoted a rewrite belongs to that rewrite room, not to a stop room.
  for (const e of episodes) if (e.type === 'edit-sequence' && e.promoted && e.corroboratedBy) consumed.add(e.corroboratedBy);

  // 2. Stops grouped by the object they cut off. Pivot-looking replies become neutral events, one per stop.
  for (const e of interrupts) {
    if (consumed.has(e.id)) continue;
    if (e.reply === 'pivot') {
      add(`event|ep:${e.id}`, { family: 'boundary', kind: 'event', object: { key: `ep:${e.id}`, label: e.interruptedCall?.name ?? 'a reply', kind: 'none' }, projectBound: false }, e);
      continue;
    }
    // A reply that draws no line and changes no plan is counted in the mirror; it never becomes a room.
    if (e.reply === 'other') continue;
    // Only a reply that is about the cut-off object groups by that object; any other stop stands alone.
    const obj = e.relatesToCut ? interruptObject(e, cwdOf.get(e.sessionId) ?? null) : null;
    const object = obj ?? { key: `ep:${e.id}`, label: e.interruptedCall?.name ?? 'a reply', kind: 'none' as const };
    add(`stop|${object.key}`, { family: 'stop', kind: 'encounter', object, projectBound: false }, e);
  }

  // 3. Repeated unsuccessful commands, per command prefix and project.
  for (const e of episodes) {
    if (e.type !== 'repeated-command') continue;
    add(`repeated-command|cmd:${e.prefix}|${e.projectKey ?? ''}`, { family: 'repeated-command', kind: 'encounter', object: { key: `cmd:${e.prefix}`, label: e.prefix, kind: 'command' }, projectBound: true }, e);
  }

  // 4. Rewrites: only promoted edit sequences (an interrupt landed on the file). Candidates stay in the mirror.
  for (const e of episodes) {
    if (e.type !== 'edit-sequence' || !e.promoted) continue;
    const short = e.file.startsWith('/') ? '…/' + e.file.split('/').slice(-2).join('/') : e.file;
    add(`rewrite|file:${e.file}|${e.projectKey ?? ''}`, { family: 'rewrite', kind: 'encounter', object: { key: `file:${e.file}`, label: short, match: e.file, kind: 'file' }, projectBound: true }, e);
  }

  // 5. Workflows: verified only when the same narrow sequence appears in two or more sessions.
  for (const e of episodes) {
    if (e.type !== 'workflow') continue;
    add(`workflow|${e.workflowKey}`, { family: 'workflow', kind: 'workshop', object: { key: `workflow:${e.workflowKey}`, label: 'focused test → diff review → report', kind: 'workflow' }, projectBound: false }, e);
  }

  const rooms: Room[] = [];
  for (const g of groups.values()) {
    const r = finalizeRoom(g);
    if (r) rooms.push(r);
  }
  return rooms.sort(compareRooms);
}

function finalizeRoom(g: Group): Room | null {
  const eps = [...g.episodes].sort((a, b) => tsOf(a) - tsOf(b));
  if (eps.length === 0) return null;
  const order: string[] = [];
  for (const e of eps) if (!order.includes(e.sessionId)) order.push(e.sessionId);
  if (g.family === 'workflow' && order.length < 2) return null;
  const ieAll = eps.filter((e): e is InterruptEpisode => e.type === 'interrupt');
  const narrowedAll = ieAll.length > 0 && ieAll.length === eps.length && ieAll.every((e) => !!e.followUp && isNarrowing(e));
  // Stops on one object across sessions are the same line only when the evidence shows it (every stop narrowed the
  // same run); otherwise the room stays a boundary room with several sessions and the player confirms each case.
  const family: Family = g.family === 'stop' ? (order.length >= 2 && narrowedAll ? 'directive' : 'boundary') : g.family;
  const withholdN = g.kind === 'encounter' && order.length > MIN_IN_ROOM ? Math.min(MAX_WITHHELD, order.length - MIN_IN_ROOM) : 0;
  const held = new Set(order.slice(order.length - withholdN));
  const inRoom = eps.filter((e) => !held.has(e.sessionId));
  // One boss case per withheld session (its first); other episodes from those sessions stay out of the room.
  const withheld = order.slice(order.length - withholdN).map((sid) => eps.find((e) => e.sessionId === sid)!);
  const anchor = [...inRoom].sort((a, b) => anchorScore(b) - anchorScore(a) || tsOf(a) - tsOf(b))[0]!;
  const projKeys = [...new Set(eps.map((e) => e.projectKey))];
  const projects = projKeys.map((k) => ({ key: k, label: eps.find((e) => e.projectKey === k)?.projectLabel ?? null }));
  const single = projKeys.length === 1 ? projects[0]! : null;
  const nSessions = order.length - withholdN;
  const n = inRoom.length;
  let subtitle: string;
  switch (family) {
    case 'repeated-command':
      subtitle = `${g.object.label} failed and ran again with nothing changed · ${times(n, nSessions)}`;
      break;
    case 'rewrite':
      subtitle = `${g.object.label} was edited again and again, and you stopped the agent during it · ${times(n, nSessions)}`;
      break;
    case 'workflow':
      subtitle = `The same sequence, a focused test that passed, then the diff, then a report with the result · ${nSessions} sessions`;
      break;
    case 'directive':
      subtitle =
        g.object.kind === 'text'
          ? `You gave the same instruction in ${nSessions} sessions`
          : `You stopped the agent during ${g.object.label} and drew the same line · ${times(n, nSessions)}`;
      break;
    default:
      subtitle =
        g.kind === 'event'
          ? 'You stopped the agent and changed the plan. Not a problem unless you say so.'
          : nSessions > 1
            ? `You stopped the agent during ${g.object.label} in ${nSessions} sessions; check each case is the same line · ${times(n, nSessions)}`
            : `You stopped the agent during ${g.object.label}, then drew a line · ${times(n, nSessions)}`;
  }
  const quote = g.kind !== 'event' && (anchor.type === 'interrupt' || anchor.type === 'directive') ? anchor.receipt.quote : null;
  const narrowedTests = ieAll.length > 0 && ieAll.every((e) => !!e.followUp && isNarrowing(e));
  const projectPart = g.projectBound ? anchor.projectKey ?? '' : single ? single.key ?? '' : '*';
  return {
    key: `${g.kind === 'event' ? 'event' : family}|${g.object.key}|${projectPart}`,
    family,
    kind: g.kind,
    object: g.object,
    projectKey: single ? single.key : null,
    projectLabel: single ? single.label : null,
    projects,
    agents: [...new Set(eps.map((e) => e.agent))],
    episodes: inRoom,
    withheld,
    anchor,
    sessions: nSessions,
    totalSessions: order.length,
    name: g.kind === 'event' ? NAMES.event : NAMES[family],
    subtitle,
    proposedConstraint: (family === 'boundary' || family === 'directive') && quote ? proposeConstraint(quote) : null,
    narrowedTests,
    group: g,
  };
}

/** The cut-off run was a whole test suite and the next run of the same runner was a focused one. */
function isNarrowing(e: InterruptEpisode): boolean {
  const cut = e.interruptedCall;
  const next = e.followUp;
  if (!cut?.command || !next?.command) return false;
  return narrowedRerun(cut, next) && isTestCommand(cut.command) && !isFocusedTest(cut.command) && isFocusedTest(next.command);
}

/** Strongest first: more distinct sessions, then a typed receipt, then the earliest anchor. */
export function compareRooms(a: Room, b: Room): number {
  const kindRank = (r: Room) => (r.kind === 'encounter' ? 0 : r.kind === 'workshop' ? 1 : 2);
  return kindRank(a) - kindRank(b) || b.totalSessions - a.totalSessions || anchorScore(b.anchor) - anchorScore(a.anchor) || tsOf(a.anchor) - tsOf(b.anchor);
}

/**
 * The player confirmed one project for a room: the room keeps only that project's cases; the rest form a new room
 * under the same family and object. Both are rebuilt with the same rules (withholding included).
 */
export function splitByProject(room: Room, projectKey: string | null): Room[] {
  const all = [...room.episodes, ...room.withheld];
  const mine = all.filter((e) => e.projectKey === projectKey);
  const rest = all.filter((e) => e.projectKey !== projectKey);
  const out: Room[] = [];
  for (const eps of [mine, rest]) {
    const r = finalizeRoom({ ...room.group, projectBound: true, episodes: eps });
    if (r) out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------ cases

/** Case facts are observed facts of the episode, read through its room's family. */
export function caseFor(e: Episode, room: Room, confirmedConstraint?: string): Case {
  let facts: CaseFacts;
  switch (e.type) {
    case 'repeated-command':
      facts = { event: 'command_failed', fingerprint: e.fingerprint, ...(e.program ? { program: e.program } : {}) };
      break;
    case 'interrupt': {
      const c = e.interruptedCall;
      facts = { event: 'resume_after_interrupt' };
      if (c?.command) facts.fingerprint = fingerprint(c.command);
      if (e.cutPath) facts.path = e.cutPath;
      break;
    }
    case 'directive':
      facts = { event: 'directive_repeated' };
      break;
    case 'edit-sequence':
      facts = { event: 'file_rewritten', path: e.file };
      break;
    case 'workflow':
      facts = { event: 'workflow_completed', workflowKey: e.workflowKey };
      break;
  }
  if (room.object.kind === 'text') facts.constraintKey = room.object.key.slice('text:'.length);
  else if (confirmedConstraint) facts.constraintKey = confirmedConstraint;
  return {
    id: e.id,
    agent: e.agent,
    projectKey: e.projectKey,
    projectLabel: e.projectLabel,
    family: room.family,
    facts,
    eligibleResponseKeys: FAMILY_KEYS[room.family],
    disposition: 'unreviewed',
    evidenceRefs: [{ sessionId: e.sessionId, agent: e.agent, turn: e.turn, callId: refCall(e) }],
  };
}

function refCall(e: Episode): string | null {
  switch (e.type) {
    case 'repeated-command':
      return e.failures[1] ?? null;
    case 'interrupt':
      return e.interruptedCall?.callId ?? null;
    case 'edit-sequence':
      return e.edits[0] ?? null;
    case 'workflow':
      return e.callIds[0] ?? null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ dispositions

/** Player dispositions per episode id. Ids are stable across re-imports of the same files. */
export class Dispositions {
  private m = new Map<string, Disposition>();
  get(id: string): Disposition {
    return this.m.get(id) ?? 'unreviewed';
  }
  set(id: string, d: Disposition): void {
    if (d === 'unreviewed') this.m.delete(id);
    else this.m.set(id, d);
  }
  get size(): number {
    return this.m.size;
  }
  toJSON(): { version: 1; dispositions: Record<string, Disposition> } {
    return { version: 1, dispositions: Object.fromEntries([...this.m.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  }
  static fromJSON(v: unknown): Dispositions {
    const d = new Dispositions();
    const o = v as { version?: number; dispositions?: Record<string, unknown> } | null;
    if (!o || o.version !== 1 || !o.dispositions || typeof o.dispositions !== 'object') return d;
    const ok = new Set<Disposition>(['issue', 'pivot', 'not-a-problem', 'unclear']);
    for (const [k, val] of Object.entries(o.dispositions)) if (typeof val === 'string' && ok.has(val as Disposition)) d.m.set(k, val as Disposition);
    return d;
  }
}

// ------------------------------------------------------------------ route

export type NodeKind = 'encounter' | 'event' | 'campfire' | 'elite' | 'review' | 'workshop' | 'card-review' | 'boss' | 'audit' | 'apply';

export interface RouteNode {
  /** Slot in the eight-node route (1–8). Slots without evidence are dropped, never padded. */
  slot: number;
  kind: NodeKind;
  /** Room keys shown at this node, in order. */
  rooms: string[];
}

export interface Route {
  nodes: RouteNode[];
  /** Encounter rooms that did not fit the act; reachable from the mirror. */
  leftovers: string[];
}

export const REVIEW_CAP = 3;
export const ELITE_SESSIONS = 3;

/**
 * The linear act: 1 strongest anchored encounter · 2 a neutral pivot event or another encounter · 3 campfire ·
 * 4 recurring-pattern elite (≥3 sessions) or an ordinary review (up to three rooms) · 5 workshop or existing-card
 * review · 6 campfire · 7 boss (withheld cases) or final audit · 8 apply.
 */
export function buildRoute(rooms: Room[], opts: { importedCards: number } = { importedCards: 0 }): Route {
  const enc = rooms.filter((r) => r.kind === 'encounter').sort(compareRooms);
  const events = rooms.filter((r) => r.kind === 'event').sort(compareRooms);
  const shops = rooms.filter((r) => r.kind === 'workshop').sort(compareRooms);
  const pool = [...enc];
  const nodes: RouteNode[] = [];
  const placed: Room[] = [];
  const take = (r: Room | undefined) => {
    if (!r) return null;
    pool.splice(pool.indexOf(r), 1);
    placed.push(r);
    return r;
  };
  const n1 = take(pool[0]);
  if (n1) nodes.push({ slot: 1, kind: 'encounter', rooms: [n1.key] });
  if (events.length) {
    placed.push(events[0]!);
    nodes.push({ slot: 2, kind: 'event', rooms: [events[0]!.key] });
  } else {
    const n2 = take(pool[0]);
    if (n2) nodes.push({ slot: 2, kind: 'encounter', rooms: [n2.key] });
  }
  // A campfire needs something to work on: the first campfire follows an encounter (an event yields no card).
  if (n1) nodes.push({ slot: 3, kind: 'campfire', rooms: [] });
  const elite = pool.find((r) => r.totalSessions >= ELITE_SESSIONS);
  if (elite) {
    take(elite);
    nodes.push({ slot: 4, kind: 'elite', rooms: [elite.key] });
  } else if (pool.length) {
    const review = pool.slice(0, REVIEW_CAP);
    for (const r of review) take(r);
    nodes.push({ slot: 4, kind: 'review', rooms: review.map((r) => r.key) });
  }
  if (shops.length) {
    placed.push(...shops);
    nodes.push({ slot: 5, kind: 'workshop', rooms: shops.map((r) => r.key) });
  } else if (opts.importedCards > 0) nodes.push({ slot: 5, kind: 'card-review', rooms: [] });
  if (nodes.some((n) => n.slot === 4 || n.slot === 5)) nodes.push({ slot: 6, kind: 'campfire', rooms: [] });
  const withheld = placed.filter((r) => r.withheld.length > 0);
  nodes.push(withheld.length ? { slot: 7, kind: 'boss', rooms: withheld.map((r) => r.key) } : { slot: 7, kind: 'audit', rooms: [] });
  nodes.push({ slot: 8, kind: 'apply', rooms: [] });
  return { nodes, leftovers: pool.map((r) => r.key) };
}

export { contentTokens, isPasted };
