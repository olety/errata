// Card and case model (spec §3). Cards are structured by construction: in-game cards come from
// the family templates, so trigger / response_key / targets / scope are data, not prose.
// Cards are immutable values: every change goes through updateCard() in ./card.ts, and the player's
// mapping acceptance is bound to a digest of the fields that decide coverage.

import type { Agent } from '../model';

export type Family =
  | 'repeated-command' // repeated unsuccessful command
  | 'rewrite' // confirmed rewrite problem: a promoted same-file edit sequence
  | 'boundary' // boundary intervention: an interrupt followed by a stated line, one session
  | 'directive' // repeated genuine directive: the same line in two or more sessions
  | 'workflow'; // repeated successful workflow (the narrow recogniser, two or more sessions)

export type CardType = 'rule' | 'skill' | 'protected' | 'trait';
export type Targets = 'claude' | 'codex' | 'both';

/** Project scope binds to the opaque project key, never to the display label alone. */
export type Scope = { kind: 'global' } | { kind: 'project'; projectKey: string; label: string };

/**
 * Observed facts a trigger is evaluated against. A missing field is unknown, and unknown is not true.
 * constraintKey: the reviewed constraint the player confirmed for this case (boundary family).
 */
export type CaseEvent = 'command_failed' | 'resume_after_interrupt' | 'directive_repeated' | 'file_rewritten' | 'workflow_completed';

export interface CaseFacts {
  event?: CaseEvent;
  /** The command involved (the failing command, or the command an interrupt cut off), arguments preserved. */
  fingerprint?: string;
  /** First word of the command, e.g. "bun". */
  program?: string;
  /** The file involved, relative to the session cwd (the rewritten file, or the edit an interrupt cut off). */
  path?: string;
  /** The reviewed constraint: confirmed by the player, or the deterministic cluster key of a repeated directive. */
  constraintKey?: string;
  workflowKey?: string;
}

/**
 * Structured trigger. Every present field must hold on the case's facts.
 * A boundary card names its constraint (constraintKey) or is explicitly generic (generic: true).
 */
export interface Trigger {
  /** One event, or any of several (a directive card answers both stops and repeated messages). */
  event: CaseEvent | readonly CaseEvent[];
  /** The case's fingerprint must start with this prefix (whole words). */
  commandPrefix?: string;
  /** The case's path must equal this path or lie under this directory prefix (ending in "/"). */
  pathPrefix?: string;
  constraintKey?: string;
  workflowKey?: string;
  /** Explicitly approved as constraint-agnostic. Without it, a boundary trigger with no constraintKey is unknown. */
  generic?: boolean;
}

/** A structured exception: when its predicate holds on the case, the card does not apply. */
export interface CardException {
  text: string;
  when: { commandPrefix?: string; projectKey?: string; pathPrefix?: string };
}

export type ResponseKey =
  | 'inspect_error_before_retry'
  | 'state_hypothesis_before_retry'
  | 'report_blocker_after_two'
  | 'targeted_patch'
  | 'reproduce_first'
  | 'summarise_hypotheses'
  | 'preserve_boundary'
  | 'confirm_scope_before_edit'
  | 'inspect_diff_against_boundary'
  | 'standing_instruction'
  | 'reread_on_resume'
  | 'record_at_handoff'
  | 'verification_gate'
  | 'result_summary'
  | 'mint_skill'
  /** Imported prose with no accepted mapping yet. Never eligible for any case. */
  | 'unmapped';

/**
 * A structured claim: what a card tells the agent to do or not do, about which object, under which condition.
 * Templates carry claims by construction; imported prose gets suggested claims the player accepts. Claims drive
 * conflict detection (opposed actions under overlapping conditions) and fuse compatibility, never coverage.
 */
export interface Claim {
  polarity: 'do' | 'dont';
  /** run, use, edit, push, report, … */
  act: string;
  /** Normalised object: 'tests:full', 'tests:focused', 'tool:uv', 'git:force-push', 'path:pyramid/tests/', 'cmd:pytest'. */
  object: string;
  /** Condition key: undefined = always; 'before-done', 'after-interrupt', … */
  when?: string;
  /** Exception wording carried by the claim ("unless the user asks"). */
  unless?: string;
}

export interface Card {
  readonly id: string;
  readonly type: CardType;
  /** Template family, or 'imported' for a line read from the player's own file. */
  readonly family: Family | 'imported';
  readonly title: string;
  readonly targets: Targets;
  readonly scope: Scope;
  readonly trigger: Readonly<Trigger>;
  readonly responseKey: ResponseKey;
  readonly exceptions: readonly Readonly<CardException>[];
  /** The player has read the current exceptions list. Reset by any exceptions change. */
  readonly exceptionsReviewed: boolean;
  /** Exact exported text: one line, no newlines, no comment terminators. */
  readonly text: string;
  /** Display counter, bumped on every change. Coverage never reads it; it reads the digest. */
  readonly textRevision: number;
  /** caseId → the card digest the player accepted the mapping for. A changed card no longer matches. */
  readonly acceptedMappings: Readonly<Record<string, string>>;
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Taken into the proposal. Whether it truly reaches an agent is decided by the rendered files (exportedTo). */
  readonly taken: boolean;
  /** Structured claims (see Claim). Part of the digest: changing them re-requires mapping approval. */
  readonly claims?: readonly Claim[];
  /** Imported prose only: where the line lives, and whether the player accepted the suggested mapping. */
  readonly source?: { file: 'claude' | 'codex'; start: number; end: number; prefix: string; eol: string };
  readonly mappingSuggested?: boolean;
  /** Skill cards: the rendered skill's slug. */
  readonly skillSlug?: string;
}

export interface EvidenceRef {
  /** Canonical session id (Session.id). */
  sessionId: string;
  agent: Agent;
  /** Turn index of the anchor (the interrupt, or the second failure). */
  turn: number;
  callId: string | null;
}

export type Disposition = 'unreviewed' | 'issue' | 'pivot' | 'not-a-problem' | 'unclear';

export interface Case {
  id: string;
  agent: Agent;
  /** Opaque project identity of the anchor turn, null when unknown. */
  projectKey: string | null;
  /** Display label for the project chip. */
  projectLabel: string | null;
  facts: CaseFacts;
  eligibleResponseKeys: ResponseKey[];
  disposition: Disposition;
  evidenceRefs: EvidenceRef[];
}

/** Which lanes the rendered proposal actually carries each card id to. Built from the rendered files. */
export interface ExportMap {
  claude: ReadonlySet<string>;
  codex: ReadonlySet<string>;
}

export const FAMILY_KEYS: Record<Family, ResponseKey[]> = {
  'repeated-command': ['inspect_error_before_retry', 'state_hypothesis_before_retry', 'report_blocker_after_two'],
  rewrite: ['targeted_patch', 'reproduce_first', 'summarise_hypotheses'],
  boundary: ['preserve_boundary', 'confirm_scope_before_edit', 'inspect_diff_against_boundary'],
  directive: ['standing_instruction', 'reread_on_resume', 'record_at_handoff'],
  workflow: ['verification_gate', 'result_summary', 'mint_skill'],
};
