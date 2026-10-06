// The two global lanes and the skill lanes. Builds next bytes for both global files from the taken cards,
// with weights, fit problems and the export map the cover rule reads.

import type { Agent } from '../model';
import type { Card, ExportMap } from './types';
import { budgetFor, fitProblem, parseGlobal, renderGlobal, weigh, type ManagedLine, type Weight } from './file';

export interface GlobalLane {
  agent: Agent;
  /** Root id and file the agent actually reads. */
  root: 'claude' | 'codex';
  rel: string;
  label: string;
  /** Why this lane cannot be written at all. The lane is left out of the plan; other lanes still apply. */
  blocker: string | null;
}

export const CODEX_OVERRIDE = 'AGENTS.override.md';

/** A non-empty override is what Codex reads (developers.openai.com/codex/guides/agents-md: "Codex uses only the first non-empty file at this level"). */
export function overrideActive(overrideBytes: Uint8Array | null): boolean {
  return !!overrideBytes && overrideBytes.length > 0 && new TextDecoder().decode(overrideBytes).trim() !== '';
}

/**
 * The Codex lane always targets AGENTS.md. A non-empty AGENTS.override.md makes AGENTS.md unread, so the lane is
 * blocked; the game never creates or edits the override.
 */
export function codexLane(overrideBytes: Uint8Array | null): GlobalLane {
  return {
    agent: 'codex',
    root: 'codex',
    rel: 'AGENTS.md',
    label: '~/.codex/AGENTS.md',
    blocker: overrideActive(overrideBytes) ? 'Your Codex reads AGENTS.override.md; edits to AGENTS.md would be ignored. The Codex lane is blocked. Remove or empty the override yourself to use it.' : null,
  };
}

export const CLAUDE_LANE: GlobalLane = { agent: 'claude', root: 'claude', rel: 'CLAUDE.md', label: '~/.claude/CLAUDE.md', blocker: null };

/**
 * Skill roots, verified in the hour-0 spike (research/out/spike-roots.md, 2026-10-06):
 *  - Claude Code personal skills: ~/.claude/skills/<name>/SKILL.md (code.claude.com/docs/en/skills).
 *  - Codex user skills: ~/.agents/skills/<name>/SKILL.md (developers.openai.com/codex/skills lists $HOME/.agents/skills).
 *    ~/.codex/skills is a deprecated root Codex still scans: read-only here, checked for name clashes, never written.
 */
export const SKILL_LANES = {
  claude: { root: 'claude-skills' as const, label: '~/.claude/skills', verified: true },
  codex: { root: 'codex-skills' as const, label: '~/.agents/skills', verified: true, legacyReadOnly: '~/.codex/skills' },
};

/** SKILL.md rules shared by both agents (agentskills.io spec, cited by the Codex docs). */
export const SKILL_FILE = { name: 'SKILL.md', nameMax: 64, namePattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, descriptionMax: 1024 } as const;

export interface LaneResult {
  lane: GlobalLane;
  original: Uint8Array | null;
  next: Uint8Array;
  before: Weight;
  after: Weight;
  allowance: number;
  noGrowth: boolean;
  /** Why Apply is blocked for this file (malformed markers, over the allowance or the byte cap), or null. */
  problem: string | null;
  /** The lane cannot be written at all (e.g. an active Codex override). Its cards do not reach this agent. */
  blocker: string | null;
}

function reaches(card: Card, agent: Agent): boolean {
  return card.taken && card.type !== 'trait' && (card.targets === 'both' || card.targets === agent);
}

/** Existing managed lines stay; a taken card with the same id replaces its line; new cards append. */
function linesFor(original: Uint8Array | null, cards: readonly Card[], agent: Agent, removed: ReadonlySet<string>): ManagedLine[] {
  const p = parseGlobal(original);
  const out: ManagedLine[] = p.managed.filter((l) => !removed.has(l.id)).map((l) => ({ ...l }));
  for (const c of cards) {
    if (!reaches(c, agent)) continue;
    const line: ManagedLine = { id: c.id, text: c.text, section: c.type === 'skill' ? 'workflows' : 'rules' };
    const i = out.findIndex((l) => l.id === c.id);
    if (i >= 0) out[i] = line;
    else out.push(line);
  }
  return out;
}

export function buildLane(lane: GlobalLane, original: Uint8Array | null, cards: readonly Card[], removed: ReadonlySet<string> = new Set(), raisedAllowance?: number): LaneResult {
  const p = parseGlobal(original);
  const budget = budgetFor(original);
  const before = weigh(original ?? new Uint8Array(0));
  if (lane.blocker || p.problem) {
    // Nothing is rendered: the file stays as it is and no card reaches this agent.
    return { lane, original, next: original ?? new Uint8Array(0), before, after: before, allowance: budget.allowance, noGrowth: budget.noGrowth, problem: lane.blocker ? null : p.problem, blocker: lane.blocker };
  }
  const lines = linesFor(original, cards, lane.agent, removed);
  const next = renderGlobal(p, lines);
  return {
    lane,
    original,
    next,
    before,
    after: weigh(next),
    allowance: Math.max(budget.allowance, raisedAllowance ?? 0),
    noGrowth: budget.noGrowth,
    problem: fitProblem(original, next, raisedAllowance),
    blocker: null,
  };
}

/** The cover rule's "in the proposed export", read from what the rendered files really contain. */
export function exportMap(claudeNext: Uint8Array, codexNext: Uint8Array): ExportMap {
  return {
    claude: new Set(parseGlobal(claudeNext).managed.map((l) => l.id)),
    codex: new Set(parseGlobal(codexNext).managed.map((l) => l.id)),
  };
}
