// The mirror (spec §8): rendered right after import, before any model. Counts carry their denominators; excluded
// system text is counted; the character card names the sampled build from a fixed table, with the activity that
// produced it underneath. No moral labels, no inferred hours, no correction vocabulary.

import type { InjectedKind, Session } from './model';
import { allCalls } from './model';
import type { Episode } from './episodes';
import { negativeCounts, isGenuineFailure, isFocusedTest, isTestCommand, type NegativeKind } from './noise';
import { commandPrefixOf, fingerprint } from './parse/common';
import type { Room } from './rooms';
import type { Dispositions } from './rooms';

export interface CharacterCard {
  name: CharacterName;
  /** The activity that produced the name, with its denominator. */
  line: string;
  evidenceSessions: number;
}

/** The fixed table. The name describes the sampled build of the agents' work, never the person. */
export const CHARACTERS = ['Boundary Keeper', 'Ritual Smith', 'Patchsmith', 'Anvil Striker', 'Lorekeeper', 'Wayfinder'] as const;
export type CharacterName = (typeof CHARACTERS)[number];

export interface Mirror {
  sessions: { total: number; claude: number; codex: number; agentAuthored: number; partial: number };
  dates: { from: string | null; to: string | null };
  projects: { total: number; sessionsWithProject: number };
  humanTurns: number;
  /** User-role text that was not a person typing: summaries, wrappers, cross-session notes, developer text. */
  excluded: { total: number; byKind: Partial<Record<InjectedKind, number>> };
  interrupts: number;
  /** Interrupts followed by the person's next message (interventions), split into lines drawn and plan changes. */
  interventions: { total: number; lines: number; pivots: number; other: number };
  repeatedCommand: { episodes: number; sessionsWith: number; shellCalls: number; genuineFailures: number };
  /** Results that looked like failures and were not, by named negative. */
  negatives: Record<NegativeKind, number>;
  editSequences: { candidates: number; sessionsWith: number; promoted: number };
  directives: { repeated: number; sessions: number };
  workflows: { occurrences: number; sessions: number; verified: number };
  /** Cases the player has confirmed as issues so far (separate from every detector count). */
  confirmedIssues: number;
  calls: { total: number; withResult: number; orphanResults: number };
  redactions: number;
  topTools: [string, number][];
  rooms: number;
  character: CharacterCard | null;
}

export function buildMirror(sessions: Session[], episodes: Episode[], rooms: Room[], disp?: Dispositions): Mirror {
  const m: Mirror = {
    sessions: { total: sessions.length, claude: 0, codex: 0, agentAuthored: 0, partial: 0 },
    dates: { from: null, to: null },
    projects: { total: 0, sessionsWithProject: 0 },
    humanTurns: 0,
    excluded: { total: 0, byKind: {} },
    interrupts: 0,
    interventions: { total: 0, lines: 0, pivots: 0, other: 0 },
    repeatedCommand: { episodes: 0, sessionsWith: 0, shellCalls: 0, genuineFailures: 0 },
    negatives: negativeCounts(sessions),
    editSequences: { candidates: 0, sessionsWith: 0, promoted: 0 },
    directives: { repeated: 0, sessions: 0 },
    workflows: { occurrences: 0, sessions: 0, verified: 0 },
    confirmedIssues: 0,
    calls: { total: 0, withResult: 0, orphanResults: 0 },
    redactions: 0,
    topTools: [],
    rooms: rooms.length,
    character: null,
  };
  const tools = new Map<string, number>();
  const projects = new Set<string>();
  const dates: string[] = [];
  for (const s of sessions) {
    m.sessions[s.agent]++;
    if (s.agentAuthored) m.sessions.agentAuthored++;
    if (s.partial) m.sessions.partial++;
    if (s.projectKey) {
      projects.add(s.projectKey);
      m.projects.sessionsWithProject++;
    }
    if (s.startedAt) dates.push(s.startedAt);
    if (s.endedAt) dates.push(s.endedAt);
    m.calls.orphanResults += s.stats.orphanResults;
    for (const v of Object.values(s.stats.redactions)) m.redactions += v;
    for (const t of s.turns) {
      if (t.role === 'human') m.humanTurns++;
      if (t.role === 'injected') {
        m.excluded.total++;
        const k = t.injected ?? 'tag';
        m.excluded.byKind[k] = (m.excluded.byKind[k] ?? 0) + 1;
      }
      if (t.role === 'interrupt' && !s.agentAuthored) m.interrupts++;
    }
    for (const c of allCalls(s)) {
      m.calls.total++;
      if (c.result) m.calls.withResult++;
      tools.set(c.name, (tools.get(c.name) ?? 0) + 1);
      if (c.kind === 'shell') {
        m.repeatedCommand.shellCalls++;
        if (isGenuineFailure(c)) m.repeatedCommand.genuineFailures++;
      }
    }
  }
  dates.sort();
  m.dates = { from: dates[0]?.slice(0, 10) ?? null, to: dates[dates.length - 1]?.slice(0, 10) ?? null };
  m.projects.total = projects.size;
  const sessionsOf = (pred: (e: Episode) => boolean) => new Set(episodes.filter(pred).map((e) => e.sessionId));
  const paired = episodes.filter((e) => e.type === 'interrupt' && e.humanTurn !== null);
  m.interventions.total = paired.length;
  m.interventions.pivots = paired.filter((e) => e.type === 'interrupt' && e.reply === 'pivot').length;
  m.interventions.lines = paired.filter((e) => e.type === 'interrupt' && e.reply === 'line').length;
  m.interventions.other = m.interventions.total - m.interventions.lines - m.interventions.pivots;
  const rc = episodes.filter((e) => e.type === 'repeated-command');
  m.repeatedCommand.episodes = rc.length;
  m.repeatedCommand.sessionsWith = sessionsOf((e) => e.type === 'repeated-command').size;
  const es = episodes.filter((e) => e.type === 'edit-sequence');
  m.editSequences = { candidates: es.length, sessionsWith: sessionsOf((e) => e.type === 'edit-sequence').size, promoted: es.filter((e) => e.type === 'edit-sequence' && e.promoted).length };
  const textRooms = rooms.filter((r) => r.family === 'directive' && r.object.kind === 'text');
  m.directives = { repeated: textRooms.length, sessions: new Set(textRooms.flatMap((r) => [...r.episodes, ...r.withheld].map((e) => e.sessionId))).size };
  const wf = episodes.filter((e) => e.type === 'workflow');
  m.workflows = { occurrences: wf.length, sessions: sessionsOf((e) => e.type === 'workflow').size, verified: rooms.filter((r) => r.family === 'workflow').length };
  if (disp) for (const e of episodes) if (disp.get(e.id) === 'issue') m.confirmedIssues++;
  m.topTools = [...tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  m.character = character(m, episodes, sessions.length);
  return m;
}

/**
 * Pick the build's name: the family whose evidence touches the largest share of sampled sessions (at least two
 * sessions), ties broken by the table order. The line under it is the activity, with its own denominator.
 */
export function character(m: Mirror, episodes: Episode[], total: number): CharacterCard | null {
  const sess = (pred: (e: Episode) => boolean) => new Set(episodes.filter(pred).map((e) => e.sessionId)).size;
  const lineSessions = sess((e) => e.type === 'interrupt' && e.humanTurn !== null && e.reply === 'line');
  const pivotSessions = sess((e) => e.type === 'interrupt' && e.humanTurn !== null && e.reply === 'pivot');
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // Boundary Keeper's line is counts only: stops that drew a line, and what most of them cut off.
  const stops = episodes.filter((e): e is Extract<Episode, { type: 'interrupt' }> => e.type === 'interrupt' && e.humanTurn !== null && e.reply === 'line');
  const cutoff = new Map<string, number>();
  for (const e of stops) {
    const c = e.interruptedCall;
    const what = !c ? null : c.kind === 'shell' && c.command ? (isTestCommand(c.command) && !isFocusedTest(c.command) ? 'a full test run' : `\`${commandPrefixOf(fingerprint(c.command))}\``) : c.kind === 'edit' ? 'an edit' : null;
    if (what) cutoff.set(what, (cutoff.get(what) ?? 0) + 1);
  }
  const top = [...cutoff.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const stopLine = `${plural(stops.length, 'stop')} in ${plural(total, 'session')}${top && top[1] >= 2 ? ` · ${top[1]} cut off ${top[0]}` : ''}`;
  const table: Record<CharacterName, { n: number; line: string }> = {
    'Boundary Keeper': { n: lineSessions, line: stopLine },
    'Ritual Smith': { n: m.workflows.sessions, line: `The same check, diff and report sequence ran in ${m.workflows.sessions} of ${plural(total, 'session')}` },
    Patchsmith: { n: m.editSequences.sessionsWith, line: `${m.editSequences.sessionsWith} of ${plural(total, 'session')} had three or more edits to one file` },
    'Anvil Striker': { n: m.repeatedCommand.sessionsWith, line: `A failed command ran again unchanged in ${m.repeatedCommand.sessionsWith} of ${plural(total, 'session')}` },
    Lorekeeper: { n: m.directives.sessions, line: `The same instruction was given in ${m.directives.sessions} of ${plural(total, 'session')}` },
    Wayfinder: { n: pivotSessions, line: `${m.interventions.pivots} of ${plural(m.interventions.total, 'intervention')} changed the plan rather than drew a line` },
  };
  let best: CharacterName | null = null;
  for (const name of CHARACTERS) {
    const t = table[name];
    if (t.n < 2) continue;
    if (best === null || t.n > table[best].n) best = name;
  }
  return best ? { name: best, line: table[best].line, evidenceSessions: table[best].n } : null;
}
