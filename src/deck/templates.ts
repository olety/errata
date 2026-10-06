// The 1-of-3 draft (spec §4) for all five families. Each option differs in what the agent will do, and every text is
// grounded in the room's own object: the command, the file or directory, the person's own wording, the workflow.
// Cards are structured by construction: trigger, response_key, targets, scope and claims are data, not prose.

import type { Agent } from '../model';
import type { Card, Claim, Family, ResponseKey, Scope, Targets, Trigger } from './types';
import type { Room } from '../rooms';
import type { Episode, WorkflowEpisode } from '../episodes';
import { sanitizeLine } from './file';
import { suggestClaims } from './claims';
import { drawsLine } from '../episodes';

/** FNV-1a, 24 bits, base36: stable short ids from the card's structure. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 0xffffff).toString(36).padStart(4, '0');
}

/** Normalized key for a constraint the player stated in their own words. */
export function constraintKeyOf(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}/._-]+/gu, ' ').trim().replace(/\s+/g, ' ').slice(0, 120);
}

export const VERIFY_SKILL_SLUG = 'verify-change';

interface Draft {
  key: ResponseKey;
  title: string;
  text: string;
  trigger: Trigger;
  claims: Claim[];
  type?: Card['type'];
  skillSlug?: string;
}

function projectClause(scope: Scope): string {
  return scope.kind === 'project' ? `In ${scope.label}, ` : '';
}

/** Join a project clause and a sentence: "In api, when …" or "When …". */
function sentence(scope: Scope, body: string): string {
  const pc = projectClause(scope);
  const b = body.trim();
  return pc ? pc + b.charAt(0).toLowerCase() + b.slice(1) : b.charAt(0).toUpperCase() + b.slice(1);
}

function endStop(s: string): string {
  const t = s.trim().replace(/[\s.…]+$/, '');
  return /[!?]$/.test(t) ? t : t + '.';
}

const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';

/** The scope a room proposes: its one project when every case shares it, else all projects. */
export function proposedScope(room: Room): Scope {
  return room.projectKey ? { kind: 'project', projectKey: room.projectKey, label: room.projectLabel ?? 'this project' } : { kind: 'global' };
}

function targetsFor(agents: Agent[]): Targets {
  return agents.length === 1 ? agents[0]! : 'both';
}

function objectTrigger(room: Room, events: Trigger['event']): Trigger | null {
  const m = room.object.match ?? room.object.label;
  if (room.object.kind === 'command') return { event: events, commandPrefix: m };
  if (room.object.kind === 'path' || room.object.kind === 'file') return { event: events, pathPrefix: m };
  if (room.object.kind === 'text') return { event: events, constraintKey: room.object.key.slice('text:'.length) };
  return null;
}

function objectWords(room: Room): string {
  if (room.object.kind === 'command' || room.object.kind === 'path' || room.object.kind === 'file') return code(room.object.label);
  return 'this';
}

function polarityOf(text: string): 'do' | 'dont' {
  return /\b(?:never|don'?t|dont|do not|not|no|avoid|stop|without)\b/i.test(text) ? 'dont' : 'do';
}

function drafts(room: Room, scope: Scope, wording: string | null): Draft[] {
  const s = (b: string) => sentence(scope, b);
  const obj = room.object.label;
  switch (room.family) {
    case 'repeated-command': {
      const cmd = code(obj);
      const trigger: Trigger = { event: 'command_failed', commandPrefix: obj };
      const o = `cmd:${obj}`;
      return [
        { key: 'inspect_error_before_retry', title: 'Read the error first', text: s(`when ${cmd} fails, read its error output before running it again unchanged.`), trigger, claims: [{ polarity: 'do', act: 'read-error', object: o, when: 'after-failure' }] },
        { key: 'state_hypothesis_before_retry', title: 'Name the change', text: s(`before re-running a failed ${cmd}, say what changed or what new hypothesis the retry tests.`), trigger, claims: [{ polarity: 'do', act: 'state-hypothesis', object: o, when: 'after-failure' }] },
        { key: 'report_blocker_after_two', title: 'Stop after two', text: s(`after ${cmd} fails twice, stop and report the blocker with both attempts instead of retrying.`), trigger, claims: [{ polarity: 'dont', act: 'retry', object: o, when: 'after-two-failures' }] },
      ];
    }
    case 'rewrite': {
      const f = code(obj);
      const trigger: Trigger = { event: 'file_rewritten', pathPrefix: room.object.match ?? obj };
      const o = `path:${room.object.match ?? obj}`;
      return [
        { key: 'targeted_patch', title: 'One targeted patch', text: s(`when changing ${f}, make one targeted patch within the reviewed scope instead of rewriting it again.`), trigger, claims: [{ polarity: 'dont', act: 'rewrite', object: o }] },
        { key: 'reproduce_first', title: 'Reproduce it first', text: s(`before editing ${f} again, add or run a focused check that reproduces the problem.`), trigger, claims: [{ polarity: 'do', act: 'reproduce', object: o, when: 'before-edit' }] },
        { key: 'summarise_hypotheses', title: 'Summarise what failed', text: s(`before a third edit to ${f}, summarise what the earlier edits tried and why they did not work.`), trigger, claims: [{ polarity: 'do', act: 'summarise', object: o, when: 'before-edit' }] },
      ];
    }
    case 'boundary': {
      const ev: Trigger['event'] = 'resume_after_interrupt';
      const named = objectTrigger(room, ev) ?? (wording ? { event: ev, constraintKey: constraintKeyOf(wording) } : { event: ev });
      const generic = objectTrigger(room, ev) ?? { event: ev, generic: true };
      const ow = objectWords(room);
      const lineObj = room.object.kind === 'path' ? `path:${obj}` : room.object.kind === 'command' ? `cmd:${obj}` : 'boundary:stated';
      const w = wording ? endStop(wording) : null;
      return [
        {
          key: 'preserve_boundary',
          title: 'Keep the stated line',
          text: w ? s(`${w} Keep to this after any interruption, for the rest of the task.`) : s('when the user stops you and states a boundary, keep to it for the rest of the task.'),
          trigger: named,
          claims: w ? [{ polarity: polarityOf(w), act: room.object.kind === 'command' ? 'run' : 'edit', object: lineObj }] : [],
        },
        {
          key: 'confirm_scope_before_edit',
          title: 'Confirm the new scope',
          text: s(room.object.kind === 'none' ? 'after the user interrupts, restate the revised scope in one line before the next edit.' : `after the user stops you during ${ow}, restate the revised scope in one line before the next step.`),
          trigger: generic,
          claims: [{ polarity: 'do', act: 'confirm-scope', object: lineObj, when: 'after-interrupt' }],
        },
        {
          key: 'inspect_diff_against_boundary',
          title: 'Check the diff',
          text: s(room.object.kind === 'none' ? 'after an interruption, check the final diff against the boundary the user stated before reporting done.' : `after an interruption during ${ow}, check the final diff against the line the user drew before reporting done.`),
          trigger: generic,
          claims: [{ polarity: 'do', act: 'inspect-diff', object: lineObj, when: 'before-done' }],
        },
      ];
    }
    case 'directive': {
      const ev: Trigger['event'] = ['resume_after_interrupt', 'directive_repeated'];
      const trig = objectTrigger(room, ev) ?? (wording ? { event: ev, constraintKey: constraintKeyOf(wording) } : { event: ev });
      const ow = objectWords(room);
      const w = wording ? endStop(wording) : null;
      let a: Draft;
      if (room.narrowedTests && room.object.kind === 'command') {
        const prog = obj.split(' ')[0]!;
        a = {
          key: 'standing_instruction',
          title: 'A standing instruction',
          text: s(`when testing with ${code(prog)}, run only the test file for the change; run the whole suite only when the user asks.`),
          trigger: trig,
          claims: [
            { polarity: 'dont', act: 'run', object: 'tests:full', unless: 'the user asks' },
            { polarity: 'do', act: 'run', object: 'tests:focused' },
          ],
        };
      } else if (w && drawsLine(w) && (room.object.kind === 'text' || room.object.kind === 'none' || w.toLowerCase().includes(obj.toLowerCase().replace(/\/$/, '')))) {
        a = { key: 'standing_instruction', title: 'A standing instruction', text: s(w), trigger: trig, claims: suggestClaims(w) };
      } else if (room.object.kind === 'command') {
        // The person's words draw no clear line; the evidence does: they stopped this command in several sessions.
        a = { key: 'standing_instruction', title: 'A standing instruction', text: s(`ask before running ${ow}; the user stopped it in ${room.totalSessions} sessions.`), trigger: trig, claims: [{ polarity: 'dont', act: 'run', object: `cmd:${obj}`, unless: 'the user asks' }] };
      } else if (room.object.kind === 'path') {
        a = { key: 'standing_instruction', title: 'A standing instruction', text: s(`ask before editing files under ${ow}; the user stopped such edits in ${room.totalSessions} sessions.`), trigger: trig, claims: [{ polarity: 'dont', act: 'edit', object: `path:${obj}`, unless: 'the user asks' }] };
      } else {
        a = { key: 'standing_instruction', title: 'A standing instruction', text: w ? s(w) : s(`follow the instruction the user repeated about ${ow}.`), trigger: trig, claims: w ? suggestClaims(w) : [] };
      }
      const about = room.narrowedTests ? 'about running tests' : room.object.kind === 'text' ? 'from earlier in the task' : `about ${ow}`;
      return [
        a,
        { key: 'reread_on_resume', title: 'Reread on resuming', text: s(`when resuming after an interruption or a context summary, reread the standing instructions ${about} before the next step.`), trigger: trig, claims: [{ polarity: 'do', act: 'reread-instructions', object: 'instructions', when: 'after-interrupt' }] },
        {
          key: 'record_at_handoff',
          title: 'Carry it across handoffs',
          text: s(`at a handoff or a context summary, write the user's standing constraint into the summary${w ? `: ${w}` : '.'}`),
          trigger: trig,
          claims: [{ polarity: 'do', act: 'record-constraint', object: 'handoff', when: 'at-handoff' }],
        },
      ];
    }
    case 'workflow': {
      const wf = room.episodes.filter((e): e is WorkflowEpisode => e.type === 'workflow');
      const progs = [...new Set(wf.map((e) => e.testProgram).filter(Boolean))];
      const runner = progs.length === 1 ? ` with ${code(progs[0]!)}` : '';
      const trigger: Trigger = { event: 'workflow_completed', workflowKey: wf[0]?.workflowKey ?? 'focused-test>diff-review>report' };
      return [
        { key: 'verification_gate', title: 'A verification gate', text: s(`before reporting a fix done, run the focused test for it${runner} and confirm it passes.`), trigger, claims: [{ polarity: 'do', act: 'run', object: 'tests:focused', when: 'before-done' }] },
        { key: 'result_summary', title: 'A result-bearing report', text: s('when reporting done, say what changed and give the test result with its pass count.'), trigger, claims: [{ polarity: 'do', act: 'report', object: 'result-summary', when: 'before-done' }] },
        {
          key: 'mint_skill',
          title: 'Mint it as a Skill',
          text: s(`for the reviewed fix-and-verify workflow, use the ${code(VERIFY_SKILL_SLUG)} skill.`),
          trigger,
          claims: [
            { polarity: 'do', act: 'run', object: 'tests:focused', when: 'before-done' },
            { polarity: 'do', act: 'report', object: 'result-summary', when: 'before-done' },
          ],
          type: 'skill',
          skillSlug: VERIFY_SKILL_SLUG,
        },
      ];
    }
  }
}

export interface DraftOptions {
  scope?: Scope;
  targets?: Targets;
  /** The player's wording of the line (boundary and directive families). Defaults to the room's proposal. */
  wording?: string | null;
}

/** Three response cards for a room, or none for an event room (a pivot has no card). */
export function draftCards(room: Room, opts: DraftOptions = {}): Card[] {
  if (room.kind === 'event') return [];
  const scope: Scope = opts.scope ?? proposedScope(room);
  const targets = opts.targets ?? targetsFor(room.agents);
  const raw = opts.wording !== undefined ? opts.wording : room.proposedConstraint;
  const wording = raw ? sanitizeLine(raw) : null;
  return drafts(room, scope, wording).map((d) => {
    const prefix = d.type === 'skill' ? 's' : 'r';
    const id = `${prefix}_${shortHash(`${room.family}|${room.object.key}|${d.key}|${JSON.stringify(scope)}|${JSON.stringify(d.trigger)}`)}`;
    const card: Card = {
      id,
      type: d.type ?? 'rule',
      family: room.family as Family,
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
      evidenceRefs: Object.freeze(room.episodes.map((e) => ({ sessionId: e.sessionId, agent: e.agent, turn: e.turn, callId: null }))),
      taken: false,
      claims: Object.freeze(d.claims.map((c) => Object.freeze({ ...c }))),
      ...(d.skillSlug ? { skillSlug: d.skillSlug } : {}),
    };
    return Object.freeze(card);
  });
}

export function episodeById(episodes: Episode[], id: string): Episode | undefined {
  return episodes.find((e) => e.id === id);
}
