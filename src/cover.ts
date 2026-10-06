// The exact cover rule (spec §3). A card covers a case iff all eight checks are true.
// Each check is three-valued; unknown is not true, so unknown fails the cover.

import { cardDigest } from './deck/card';
import type { Card, Case, CaseFacts, ExportMap, Scope, Trigger } from './deck/types';

export type Tri = 'true' | 'false' | 'unknown';

export const CHECKS = [
  'confirmed_issue', // 1. the player confirmed the case as an issue
  'in_export', // 2. the rendered proposal carries the card to the case's agent
  'targets_agent', // 3. the card's targets include the case's agent
  'scope_matches', // 4. the card's scope matches the case's project identity
  'trigger_true', // 5. the card's trigger evaluates true on the observed facts
  'response_eligible', // 6. the card's response_key is in the case's eligible set
  'exceptions_clear', // 7. exceptions reviewed and none excludes the case
  'mapping_accepted', // 8. the player accepted this card ↔ case mapping for the card as it is now
] as const;
export type Check = (typeof CHECKS)[number];

export interface CoverResult {
  covers: boolean;
  checks: Record<Check, Tri>;
}

function scopeMatches(scope: Scope, projectKey: string | null): Tri {
  if (scope.kind === 'global') return 'true';
  if (projectKey === null) return 'unknown';
  return scope.projectKey === projectKey ? 'true' : 'false';
}

/** Prefix match on whole words: "bun test" matches "bun test src" but not "bun testx". */
export function fingerprintHasPrefix(fp: string, prefix: string): boolean {
  const p = prefix.trim();
  if (p === '') return true;
  return fp === p || fp.startsWith(p + ' ');
}

/** "src/" matches "src/a.ts" and "src/" itself; a path without a trailing slash matches only itself. */
export function pathHasPrefix(path: string, prefix: string): boolean {
  const p = prefix.trim();
  if (p === '') return true;
  return p.endsWith('/') ? path.startsWith(p) || path + '/' === p : path === p;
}

export function evalTrigger(t: Readonly<Trigger>, f: CaseFacts): Tri {
  if (f.event === undefined) return 'unknown';
  const events = typeof t.event === 'string' ? [t.event] : t.event;
  if (!events.includes(f.event)) return 'false';
  const parts: Tri[] = [];
  if (t.commandPrefix !== undefined) parts.push(f.fingerprint === undefined ? 'unknown' : fingerprintHasPrefix(f.fingerprint, t.commandPrefix) ? 'true' : 'false');
  if (t.pathPrefix !== undefined) parts.push(f.path === undefined ? 'unknown' : pathHasPrefix(f.path, t.pathPrefix) ? 'true' : 'false');
  if (t.workflowKey !== undefined) parts.push(f.workflowKey === undefined ? 'unknown' : f.workflowKey === t.workflowKey ? 'true' : 'false');
  if (t.constraintKey !== undefined) parts.push(f.constraintKey === undefined ? 'unknown' : f.constraintKey === t.constraintKey ? 'true' : 'false');
  if (parts.includes('false')) return 'false';
  if (parts.includes('unknown')) return 'unknown';
  // A trigger that names no object at all must be approved as generic, or it is unknown, never true.
  if (parts.length === 0 && t.generic !== true) return 'unknown';
  return 'true';
}

function exceptionHolds(when: Card['exceptions'][number]['when'], c: Case): Tri {
  const parts: Tri[] = [];
  if (when.commandPrefix !== undefined) {
    parts.push(c.facts.fingerprint === undefined ? 'unknown' : fingerprintHasPrefix(c.facts.fingerprint, when.commandPrefix) ? 'true' : 'false');
  }
  if (when.projectKey !== undefined) {
    parts.push(c.projectKey === null ? 'unknown' : c.projectKey === when.projectKey ? 'true' : 'false');
  }
  if (when.pathPrefix !== undefined) {
    parts.push(c.facts.path === undefined ? 'unknown' : pathHasPrefix(c.facts.path, when.pathPrefix) ? 'true' : 'false');
  }
  if (parts.length === 0) return 'unknown'; // an exception with no predicate cannot be evaluated
  if (parts.includes('false')) return 'false';
  if (parts.includes('unknown')) return 'unknown';
  return 'true';
}

function exceptionsClear(card: Card, c: Case): Tri {
  if (!card.exceptionsReviewed) return 'unknown';
  let out: Tri = 'true';
  for (const e of card.exceptions) {
    const h = exceptionHolds(e.when, c);
    if (h === 'true') return 'false';
    if (h === 'unknown') out = 'unknown';
  }
  return out;
}

export function cover(card: Card, c: Case, exported: ExportMap): CoverResult {
  const accepted = card.acceptedMappings[c.id];
  const checks: Record<Check, Tri> = {
    confirmed_issue: c.disposition === 'issue' ? 'true' : c.disposition === 'unreviewed' || c.disposition === 'unclear' ? 'unknown' : 'false',
    in_export: card.type !== 'trait' && exported[c.agent].has(card.id) ? 'true' : 'false',
    targets_agent: card.targets === 'both' || card.targets === c.agent ? 'true' : 'false',
    scope_matches: scopeMatches(card.scope, c.projectKey),
    // A suggested mapping on imported prose is not a mapping until the player accepts it.
    trigger_true: card.mappingSuggested ? 'unknown' : evalTrigger(card.trigger, c.facts),
    response_eligible: card.responseKey !== 'unmapped' && c.eligibleResponseKeys.includes(card.responseKey) ? 'true' : 'false',
    exceptions_clear: exceptionsClear(card, c),
    mapping_accepted: accepted === undefined ? 'unknown' : accepted === cardDigest(card) ? 'true' : 'false',
  };
  return { covers: CHECKS.every((k) => checks[k] === 'true'), checks };
}

/** "N of M reviewed cases addressed by the proposed instructions". Only confirmed issues count. */
export function coverage(cards: readonly Card[], cases: readonly Case[], exported: ExportMap): { addressed: number; confirmed: number; byCase: Map<string, string[]> } {
  const byCase = new Map<string, string[]>();
  let addressed = 0;
  let confirmed = 0;
  for (const c of cases) {
    if (c.disposition !== 'issue') continue;
    confirmed++;
    const hits = cards.filter((k) => cover(k, c, exported).covers).map((k) => k.id);
    byCase.set(c.id, hits);
    if (hits.length > 0) addressed++;
  }
  return { addressed, confirmed, byCase };
}
