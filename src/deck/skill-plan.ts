// Skill cards end to end (spec §4, §9): the reviewed workflow becomes a real SKILL.md in each verified skill root,
// and a pointer line in each global file. Skill bodies are planned before the globals that point to them (the apply
// engine orders kind 'skill' first). A skill lane that is not granted drops that agent's pointer; a foreign skill of
// the same name is never overwritten; removing a pointer never deletes a skill directory.

import type { Card } from './types';
import type { Room } from '../rooms';
import type { WorkflowEpisode } from '../episodes';
import type { Target } from '../apply/engine';
import { renderSkill, skillClash, skillTargets, type RenderedSkill, type SkillSpec } from './skill';
import { presentCards, renderLanes, withCards, type DeckState, type Lanes } from './deck';
import { CODEX_OVERRIDE } from './lanes';
import { MAX_FILE_BYTES } from './file';

/** The verify-change skill, grounded in the room's own runs (the test program, both agents, the session count). */
export function skillSpecFor(card: Card, room: Room | null): SkillSpec {
  const wf = (room?.episodes ?? []).filter((e): e is WorkflowEpisode => e.type === 'workflow');
  const progs = [...new Set(wf.map((e) => e.testProgram).filter((p): p is string => !!p))];
  const example = wf[0]?.test;
  const agents = [...new Set(wf.map((e) => (e.agent === 'claude' ? 'Claude Code' : 'Codex')))];
  return {
    slug: card.skillSlug ?? 'verify-change',
    cardId: card.id,
    title: 'Verify a change',
    description: 'Check a code change before reporting it done: run the focused test, review the diff, report the result with its pass count.',
    trigger: 'After editing code to fix a failing test or a reported bug, before saying the work is done.',
    prerequisites: ['The test file or test id that covers the change is known.'],
    steps: [
      progs.length === 1 && example ? `Run only the focused test for the change (for example \`${example}\`).` : 'Run only the focused test for the change.',
      'Read the output; continue only if it passes.',
      'Run git diff --stat, then git diff, and check every changed line belongs to the task.',
      'Report what changed and the test result with its pass count.',
    ],
    verification: ['The focused test passed in this session.', 'The diff contains only the intended files.'],
    stopConditions: ['The focused test still fails after one targeted fix.', 'The diff touches files outside the task.'],
    provenance: wf.length ? `Reviewed from ${new Set(wf.map((e) => e.sessionId)).size} sessions (${agents.join(', ')}).` : undefined,
  };
}

export interface SkillLanes {
  /** The skill root is granted and verified for this agent. */
  claude: boolean;
  codex: boolean;
}

/** Skill cards reach only the agents whose skill lane is on; the other agent gets no pointer. */
export function narrowSkillCards(d: DeckState, lanes: SkillLanes): { deck: DeckState; dropped: { cardId: string; agent: 'claude' | 'codex' }[] } {
  const dropped: { cardId: string; agent: 'claude' | 'codex' }[] = [];
  const cards = d.cards.map((c) => {
    if (c.type !== 'skill' || !c.taken) return c;
    const want = c.targets === 'both' ? (['claude', 'codex'] as const) : ([c.targets] as const);
    const keep = want.filter((a) => lanes[a]);
    for (const a of want) if (!lanes[a]) dropped.push({ cardId: c.id, agent: a });
    if (keep.length === want.length) return c;
    if (keep.length === 0) return Object.freeze({ ...c, taken: false });
    return Object.freeze({ ...c, targets: keep[0]! });
  });
  return { deck: withCards(d, cards), dropped };
}

export interface ApplyTargets {
  targets: Target[];
  lanes: Lanes;
  skills: RenderedSkill[];
  /** Reasons Apply must not run (a foreign skill of the same name, a skill over the limits, a blocked file). */
  problems: string[];
  notes: string[];
}

/**
 * Everything Apply writes, in one list: skill bodies (both roots that are on), the two globals, and the Codex override
 * as a guard. `read` reads an existing file from a root (null when absent) for clash checks.
 */
export async function applyTargets(
  d0: DeckState,
  rooms: Room[],
  skillLanes: SkillLanes,
  read: (root: 'claude-skills' | 'codex-skills' | 'codex-legacy-skills', rel: string) => Promise<Uint8Array | null>,
): Promise<ApplyTargets> {
  const { deck: d, dropped } = narrowSkillCards(d0, skillLanes);
  const lanes = renderLanes(d);
  const problems: string[] = [];
  const notes = dropped.map((x) => `The ${x.agent === 'claude' ? 'Claude' : 'Codex'} skill folder is not granted, so ${x.cardId} has no pointer there.`);
  const targets: Target[] = [];
  const skills: RenderedSkill[] = [];
  for (const c of presentCards(d).filter((x) => x.type === 'skill' && x.taken && x.family !== 'imported')) {
    const room = rooms.find((r) => r.family === 'workflow') ?? null;
    const r = renderSkill(skillSpecFor(c, room));
    skills.push(r);
    if (r.problems.length) {
      problems.push(`${r.slug}: ${r.problems.join(' ')}`);
      continue;
    }
    const want = { claude: skillLanes.claude && (c.targets === 'both' || c.targets === 'claude'), codex: skillLanes.codex && (c.targets === 'both' || c.targets === 'codex') };
    for (const t of skillTargets(r, want)) {
      const clash = skillClash(await read(t.root, t.rel), t.next, c.id);
      if (clash === 'foreign') problems.push(`A different skill named ${r.slug} already exists in ${t.root === 'claude-skills' ? '~/.claude/skills' : '~/.agents/skills'}. Rename the card's skill or remove that folder yourself.`);
      else targets.push(t);
    }
    if (want.codex) {
      const legacy = await read('codex-legacy-skills', r.rel);
      if (legacy && skillClash(legacy, r.bytes, c.id) === 'foreign') problems.push(`Codex also reads ~/.codex/skills, which has a different skill named ${r.slug}. Rename the card's skill first.`);
    }
  }
  for (const l of [lanes.claude, lanes.codex]) {
    if (l.problem) problems.push(`${l.lane.label}: ${l.problem}`);
    if (!l.blocker) targets.push({ root: l.lane.root, rel: l.lane.rel, kind: 'global', next: l.next });
    if (l.next.length > MAX_FILE_BYTES) problems.push(`${l.lane.label} would exceed ${MAX_FILE_BYTES} bytes.`);
  }
  targets.push({ root: 'codex', rel: CODEX_OVERRIDE, kind: 'guard', next: new Uint8Array(0) });
  return { targets, lanes, skills, problems, notes };
}
