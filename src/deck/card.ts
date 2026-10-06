// The only way to change a card. Any change to a coverage-deciding field yields a new digest,
// so every earlier mapping acceptance stops matching without anyone remembering to clear it.

import type { Card, CardException, Claim, ResponseKey, Scope, Targets, Trigger } from './types';

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Stable JSON: object keys sorted, so equal content gives an equal digest. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Digest of every field that decides what the card says and whom it covers. */
export function cardDigest(c: Pick<Card, 'type' | 'text' | 'targets' | 'scope' | 'trigger' | 'responseKey' | 'exceptions'> & { claims?: Card['claims'] }): string {
  return fnv(stable({ type: c.type, text: c.text, targets: c.targets, scope: c.scope, trigger: c.trigger, responseKey: c.responseKey, exceptions: c.exceptions, claims: c.claims ?? [] }));
}

export interface CardPatch {
  text?: string;
  targets?: Targets;
  scope?: Scope;
  trigger?: Trigger;
  exceptions?: CardException[];
  title?: string;
  claims?: Claim[];
  responseKey?: ResponseKey;
}

/** Returns a new card. Exceptions changes reset their review; the revision counter always moves on a real change. */
export function updateCard(card: Card, patch: CardPatch, sanitize: (s: string) => string = (s) => s): Card {
  const next: Card = Object.freeze({
    ...card,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.text !== undefined ? { text: sanitize(patch.text) } : {}),
    ...(patch.targets !== undefined ? { targets: patch.targets } : {}),
    ...(patch.scope !== undefined ? { scope: structuredClone(patch.scope) } : {}),
    ...(patch.trigger !== undefined ? { trigger: Object.freeze(structuredClone(patch.trigger)) } : {}),
    ...(patch.exceptions !== undefined ? { exceptions: Object.freeze(patch.exceptions.map((e) => Object.freeze(structuredClone(e)))), exceptionsReviewed: false } : {}),
    ...(patch.claims !== undefined ? { claims: Object.freeze(patch.claims.map((c) => Object.freeze({ ...c }))) } : {}),
    ...(patch.responseKey !== undefined ? { responseKey: patch.responseKey } : {}),
  });
  const changed = cardDigest(next) !== cardDigest(card);
  return changed ? Object.freeze({ ...next, textRevision: card.textRevision + 1 }) : next;
}

export function acceptMapping(card: Card, caseId: string): Card {
  return Object.freeze({ ...card, acceptedMappings: Object.freeze({ ...card.acceptedMappings, [caseId]: cardDigest(card) }) });
}

export function reviewExceptions(card: Card): Card {
  return Object.freeze({ ...card, exceptionsReviewed: true });
}

export function setTaken(card: Card, taken: boolean): Card {
  return Object.freeze({ ...card, taken });
}
