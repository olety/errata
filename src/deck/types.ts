// Card and case model (spec §3). Cards are structured by construction: in-game cards come from
// the family templates, so trigger / response_key / targets / scope are data, not prose.
// Cards are immutable values: every change goes through updateCard() in ./card.ts, and the player's
// mapping acceptance is bound to a digest of the fields that decide coverage.

import type { Agent } from '../model';

export type Family =
  | 'repeated-command' // repeated unsuccessful command
  | 'rewrite' // confirmed rewrite problem (later leg)
  | 'boundary' // boundary intervention: an interrupt followed by a stated constraint
  | 'directive' // repeated genuine directive (later leg)
  | 'workflow'; // repeated successful workflow (later leg)

export type CardType = 'rule' | 'skill' | 'protected' | 'trait';
export type Targets = 'claude' | 'codex' | 'both';

/** Project scope binds to the opaque project key, never to the display label alone. */
export type Scope = { kind: 'global' } | { kind: 'project'; projectKey: string; label: string };

/**
 * Observed facts a trigger is evaluated against. A missing field is unknown, and unknown is not true.
 * constraintKey: the reviewed constraint the player confirmed for this case (boundary family).
 */
export interface CaseFacts {
  event?: 'command_failed' | 'resume_after_interrupt';
  fingerprint?: string;
  /** First word of the command, e.g. "bun". */
  program?: string;
  constraintKey?: string;
}

/**
 * Structured trigger. Every present field must hold on the case's facts.
 * A boundary card names its constraint (constraintKey) or is explicitly generic (generic: true).
 */
export interface Trigger {
  event: NonNullable<CaseFacts['event']>;
  /** The case's fingerprint must start with this prefix (whole words). */
  commandPrefix?: string;
  constraintKey?: string;
  /** Explicitly approved as constraint-agnostic. Without it, a boundary trigger with no constraintKey is unknown. */
  generic?: boolean;
}

/** A structured exception: when its predicate holds on the case, the card does not apply. */
export interface CardException {
  text: string;
  when: { commandPrefix?: string; projectKey?: string };
}

export type ResponseKey =
  | 'inspect_error_before_retry'
  | 'state_hypothesis_before_retry'
  | 'report_blocker_after_two'
  | 'preserve_boundary'
  | 'confirm_scope_before_edit'
  | 'inspect_diff_against_boundary';

export interface Card {
  readonly id: string;
  readonly type: CardType;
  readonly family: Family;
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

export const FAMILY_KEYS: Record<'repeated-command' | 'boundary', ResponseKey[]> = {
  'repeated-command': ['inspect_error_before_retry', 'state_hypothesis_before_retry', 'report_blocker_after_two'],
  boundary: ['preserve_boundary', 'confirm_scope_before_edit', 'inspect_diff_against_boundary'],
};
