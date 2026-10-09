// The mirror page's words, pure (no DOM): the act line and the count rows, each count with its denominator and one
// definition (P3 gate fix 8). main.ts renders them as paper slips; tests read them directly.

import type { Analysis } from '../pipeline';
import { NEGATIVE_LABELS, type NegativeKind } from '../noise';
import type { IconName } from './info';

/**
 * The act's places counted the way the list shows them (P3 gate fix 8): "8 places: 5 rooms in 4 places, 2 campfires,
 * the boss, Apply". Honesty map: route.nodes by kind; rooms = the rooms those places hold.
 */
export function actLine(A: Pick<Analysis, 'route' | 'rooms'>): string {
  const nodes = A.route.nodes;
  const roomKinds = new Set(['encounter', 'elite', 'review', 'event', 'workshop']);
  const roomNodes = nodes.filter((n) => roomKinds.has(n.kind));
  const rooms = roomNodes.reduce((a, n) => a + n.rooms.length, 0);
  const fires = nodes.filter((n) => n.kind === 'campfire').length;
  const parts = [`${rooms} ${rooms === 1 ? 'room' : 'rooms'}${roomNodes.length !== rooms ? ` in ${roomNodes.length} places` : ''}`];
  if (fires) parts.push(`${fires} ${fires === 1 ? 'campfire' : 'campfires'}`);
  if (nodes.some((n) => n.kind === 'card-review')) parts.push('your existing rules');
  if (nodes.some((n) => n.kind === 'boss')) parts.push('the boss');
  if (nodes.some((n) => n.kind === 'audit')) parts.push('the final audit');
  if (nodes.some((n) => n.kind === 'apply')) parts.push('Apply');
  const off = A.route.leftovers.length;
  return `${nodes.length} places: ${parts.join(', ')}.${off ? ` ${off} more ${off === 1 ? 'room stays' : 'rooms stay'} off this act.` : ''}`;
}

/** The mirror's rows: counts with their denominators, each defined once (P3 gate fix 8). */
export function mirrorRows(m: Analysis['mirror'], labels: Record<string, string> = NEGATIVE_LABELS): [string, string][] {
  const neg = (Object.entries(m.negatives) as [NegativeKind, number][]).filter(([, v]) => v > 0);
  const unknown = m.calls.total - m.calls.withResult - m.calls.interrupted;
  return [
    ['Sessions', `${m.sessions.total} (Claude Code ${m.sessions.claude}, Codex ${m.sessions.codex}) · ${m.dates.from ?? '–'} to ${m.dates.to ?? '–'}`],
    ['Projects', `${m.projects.total} · ${m.projects.sessionsWithProject} of ${m.sessions.total} sessions have one`],
    ['Partial sessions', `${m.sessions.partial} of ${m.sessions.total}`],
    ['Your messages', String(m.humanTurns)],
    ['Excluded system text', `${m.excluded.total} turns that were not you typing (${Object.entries(m.excluded.byKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`],
    ['Stops (you interrupted the agent)', `${m.interrupts} · ${m.interventions.total} followed by your next message: ${m.interventions.lines} drew a line, ${m.interventions.pivots} changed the plan, ${m.interventions.other} other`],
    ['Same command failing again unchanged', `${m.repeatedCommand.episodes} in ${m.repeatedCommand.sessionsWith} of ${m.sessions.total} sessions`],
    ['Failed shell runs', `${m.repeatedCommand.genuineFailures} of ${m.repeatedCommand.shellCalls} shell runs`],
    ['Looked like failures, were not', neg.length ? neg.map(([k, v]) => `${v} ${labels[k]}`).join(' · ') : 'none'],
    ['Edit sequences (3+ edits to one file)', `${m.editSequences.candidates} in ${m.editSequences.sessionsWith} of ${m.sessions.total} sessions · ${m.editSequences.promoted} with a stop on them`],
    ['The same instruction in several sessions', m.directives.repeated ? `${m.directives.repeated} · in ${m.directives.sessions} of ${m.sessions.total} sessions${m.directives.heldBack ? ` (${m.directives.heldBack} of those cases held for the boss)` : ''}` : '0'],
    ['Check → diff → report workflow', `${m.workflows.occurrences} times in ${m.workflows.sessions} of ${m.sessions.total} sessions${m.workflows.verified ? ' · verified' : ''}`],
    ['Tool calls', `${m.calls.total} · ${m.calls.withResult} with a recorded result · ${m.calls.interrupted} interrupted, no result${unknown > 0 ? ` · ${unknown} no result recorded` : ''}`],
    ['Top tools', m.topTools.map(([n, c]) => `${n} ${c}`).join(', ')],
    ['Secrets redacted while reading', String(m.redactions)],
  ];
}


/** One count tile on the mirror (text-density pass): an icon, the number with its unit and at most three words, and
 * the definition (the mirrorRows label and value, word for word) for the tile's (i). */
export interface MirrorTile {
  icon: IconName;
  text: string;
  /** The mirrorRows label (the tile's tooltip and its note title). */
  label: string;
  /** "label: value", the full definition that used to sit on the slip. */
  def: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The mirror's tiles, one per mirrorRows row and in the same order, from the same fields (no new numbers but a sum). */
export function mirrorTiles(m: Analysis['mirror'], labels: Record<string, string> = NEGATIVE_LABELS): MirrorTile[] {
  const rows = mirrorRows(m, labels);
  const notFailures = Object.values(m.negatives).reduce((a, v) => a + v, 0);
  const top = m.topTools[0];
  const short: [MirrorTile['icon'], string][] = [
    ['book', plural(m.sessions.total, 'session', 'sessions')],
    ['folder', plural(m.projects.total, 'project', 'projects')],
    ['question', `${m.sessions.partial} partial ${m.sessions.partial === 1 ? 'session' : 'sessions'}`],
    ['chat', `${m.humanTurns} your ${m.humanTurns === 1 ? 'message' : 'messages'}`],
    ['shelf', `${plural(m.excluded.total, 'turn', 'turns')} excluded`],
    ['stop', `${plural(m.interrupts, 'stop', 'stops')} · ${m.interventions.lines} drew a line`],
    ['repeat', `${m.repeatedCommand.episodes} unchanged ${m.repeatedCommand.episodes === 1 ? 'retry' : 'retries'}`],
    ['cross', `${m.repeatedCommand.genuineFailures} / ${m.repeatedCommand.shellCalls} shell runs failed`],
    ['tick', plural(notFailures, 'false alarm', 'false alarms')],
    ['quill', plural(m.editSequences.candidates, 'edit sequence', 'edit sequences')],
    ['rules', plural(m.directives.repeated, 'repeated instruction', 'repeated instructions')],
    ['knot', plural(m.workflows.occurrences, 'workflow run', 'workflow runs')],
    ['wrench', plural(m.calls.total, 'tool call', 'tool calls')],
    ['list', top ? `top: ${top[0]}` : '0 tool calls'],
    ['lock', plural(m.redactions, 'secret redacted', 'secrets redacted')],
  ];
  return rows.map(([label, value], i) => ({ icon: short[i]![0], text: short[i]![1], label, def: `${label}: ${value}` }));
}

/** The act's route strip: one icon per place kind, in the order the act visits them (text-density pass). */
export function routeIcon(kind: Analysis['route']['nodes'][number]['kind']): IconName {
  switch (kind) {
    case 'encounter':
    case 'elite':
      return 'target';
    case 'event':
      return 'bend';
    case 'review':
      return 'eye';
    case 'workshop':
      return 'wrench';
    case 'card-review':
      return 'rules';
    case 'campfire':
      return 'fire';
    case 'boss':
      return 'seal';
    case 'audit':
      return 'list';
    case 'apply':
      return 'tick';
  }
}
