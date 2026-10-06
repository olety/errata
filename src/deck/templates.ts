// The 1-of-3 draft (spec §4) for the two families this slice detects. Each option differs in what the agent
// will do. Cards are structured by construction: trigger, response_key, targets and scope are data.

import type { Agent } from '../model';
import type { Card, Case, CaseFacts, Family, ResponseKey, Scope, Targets, Trigger } from './types';
import { FAMILY_KEYS } from './types';
import type { Episode, InterruptEpisode, RepeatedCommandEpisode } from '../episodes';
import { sanitizeLine } from './file';

/** FNV-1a, 24 bits, base36: stable short ids from the card's structure. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 0xffffff).toString(36).padStart(4, '0');
}

export interface Room {
  family: Extract<Family, 'repeated-command' | 'boundary'>;
  /** What the episodes share: the command prefix, or the interrupted tool. */
  object: string;
  /** Project identity shared by every episode in the room (rooms never mix projects). */
  projectKey: string | null;
  projectLabel: string | null;
  agents: Agent[];
  episodes: Episode[];
  /** Distinct sessions supporting this room. */
  sessions: number;
  name: string;
  subtitle: string;
}

function familyOf(e: Episode): Room['family'] {
  return e.type === 'repeated-command' ? 'repeated-command' : 'boundary';
}

function objectOf(e: Episode): string {
  if (e.type === 'repeated-command') return e.prefix;
  const c = e.interruptedCall;
  if (!c) return 'a reply';
  if (c.kind === 'shell' && c.command) return (c.command.split(' ')[0] ?? c.name).replace(/^.*\//, '');
  return c.name;
}

/** Group episodes into rooms by family + object + project. Interrupts without a human reply are left out. */
export function groupRooms(episodes: Episode[]): Room[] {
  const m = new Map<string, Episode[]>();
  for (const e of episodes) {
    if (e.type === 'interrupt' && e.humanTurn === null) continue;
    const k = `${familyOf(e)}|${objectOf(e)}|${e.projectKey ?? ''}`;
    const list = m.get(k) ?? [];
    list.push(e);
    m.set(k, list);
  }
  const rooms: Room[] = [];
  for (const list of m.values()) {
    const e0 = list[0]!;
    const family = familyOf(e0);
    const object = objectOf(e0);
    const sessions = new Set(list.map((e) => e.sessionId)).size;
    const agents = [...new Set(list.map((e) => e.agent))];
    const n = list.length;
    const times = `${n} time${n === 1 ? '' : 's'} in ${sessions} session${sessions === 1 ? '' : 's'}`;
    const name = family === 'repeated-command' ? 'The unchanged retry' : 'The stop';
    const subtitle =
      family === 'repeated-command'
        ? `${object} failed and ran again with nothing changed · ${times}`
        : `You stopped the agent during ${object}, then said what to do · ${times}`;
    rooms.push({ family, object, projectKey: e0.projectKey, projectLabel: e0.projectLabel, agents, episodes: list, sessions, name, subtitle });
  }
  return rooms.sort((a, b) => b.sessions - a.sessions || b.episodes.length - a.episodes.length);
}

/** One case per episode. Every case starts unreviewed; only the player's "issue" makes it count. */
export function caseFor(e: Episode): Case {
  const facts: CaseFacts =
    e.type === 'repeated-command'
      ? { event: 'command_failed', fingerprint: e.fingerprint, ...(e.program ? { program: e.program } : {}) }
      : { event: 'resume_after_interrupt' };
  return {
    id: e.id,
    agent: e.agent,
    projectKey: e.projectKey,
    projectLabel: e.projectLabel,
    facts,
    eligibleResponseKeys: FAMILY_KEYS[familyOf(e)],
    disposition: 'unreviewed',
    evidenceRefs: [{ sessionId: e.sessionId, agent: e.agent, turn: e.turn, callId: e.type === 'repeated-command' ? e.failures[1] ?? null : e.interruptedCall?.callId ?? null }],
  };
}

/** Normalized key for a constraint the player stated in their own words. */
export function constraintKeyOf(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}/._-]+/gu, ' ').trim().replace(/\s+/g, ' ').slice(0, 120);
}

interface Draft {
  key: ResponseKey;
  title: string;
  text: string;
  trigger: Trigger;
}

function projectClause(scope: Scope): string {
  return scope.kind === 'project' ? `In ${scope.label}, ` : '';
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function drafts(room: Room, scope: Scope, boundary: string | null): Draft[] {
  const pc = projectClause(scope);
  if (room.family === 'repeated-command') {
    const cmd = `\`${room.object}\``;
    const trigger: Trigger = { event: 'command_failed', commandPrefix: room.object };
    const list: Draft[] = [
      { key: 'inspect_error_before_retry', title: 'Read the error first', text: `${pc}when ${cmd} fails, read its error output before running it again unchanged.`, trigger },
      { key: 'state_hypothesis_before_retry', title: 'Name the change', text: `${pc}before re-running a failed ${cmd}, say what changed or what new hypothesis the retry tests.`, trigger },
      { key: 'report_blocker_after_two', title: 'Stop after two', text: `${pc}after ${cmd} fails twice, stop and report the blocker with both attempts instead of retrying.`, trigger },
    ];
    return list.map((d) => ({ ...d, text: cap(d.text) }));
  }
  // Boundary family. Option A names the constraint; B and C are generic and say so in their trigger.
  const generic: Trigger = { event: 'resume_after_interrupt', generic: true };
  const named: Trigger = boundary ? { event: 'resume_after_interrupt', constraintKey: constraintKeyOf(boundary) } : { event: 'resume_after_interrupt' };
  const list: Draft[] = [
    {
      key: 'preserve_boundary',
      title: 'Keep the stated boundary',
      text: boundary ? `${pc}${boundary.replace(/[.\s]+$/, '')}. Keep to this after any interruption, for the rest of the task.` : `${pc}when the user stops you and states a boundary, keep to it for the rest of the task.`,
      trigger: named,
    },
    { key: 'confirm_scope_before_edit', title: 'Confirm the new scope', text: `${pc}after the user interrupts, restate the revised scope in one line before the next edit.`, trigger: generic },
    { key: 'inspect_diff_against_boundary', title: 'Check the diff', text: `${pc}after an interruption, check the final diff against the boundary the user stated before reporting done.`, trigger: generic },
  ];
  return list.map((d) => ({ ...d, text: cap(d.text) }));
}

function targetsFor(agents: Agent[]): Targets {
  return agents.length === 1 ? agents[0]! : 'both';
}

/**
 * Three response cards for a room. `boundary` is the player's own wording of the constraint (boundary family);
 * without it, option A's trigger stays incomplete and covers nothing until the player names the constraint.
 */
export function draftCards(room: Room, opts: { scope?: Scope; targets?: Targets; boundary?: string | null } = {}): Card[] {
  const scope: Scope = opts.scope ?? { kind: 'global' };
  const targets = opts.targets ?? targetsFor(room.agents);
  const boundary = opts.boundary ? sanitizeLine(opts.boundary) : null;
  return drafts(room, scope, boundary).map((d) => {
    const id = `r_${shortHash(`${room.family}|${d.key}|${JSON.stringify(scope)}|${JSON.stringify(d.trigger)}`)}`;
    const card: Card = {
      id,
      type: 'rule',
      family: room.family,
      title: d.title,
      targets,
      scope,
      trigger: Object.freeze(d.trigger),
      responseKey: d.key,
      exceptions: Object.freeze([]),
      exceptionsReviewed: true,
      text: sanitizeLine(d.text),
      textRevision: 1,
      acceptedMappings: Object.freeze({}),
      evidenceRefs: Object.freeze(room.episodes.map((e) => caseFor(e).evidenceRefs[0]!)),
      taken: false,
    };
    return Object.freeze(card);
  });
}

export function episodeById(episodes: Episode[], id: string): Episode | undefined {
  return episodes.find((e) => e.id === id);
}

export type { InterruptEpisode, RepeatedCommandEpisode };
