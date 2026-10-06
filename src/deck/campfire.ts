// The campfire (spec §6). Stacking proposes; confirming performs. Every operation here is a pure function from one
// deck state to the next, with a preview that renders both files for real: before/after text, scope, targets,
// trigger, exceptions, the real weight change per file, and the reviewed cases opened or addressed.

import type { Card, CardException, Case, Claim, Scope, Targets } from './types';
import { contentTokens, jaccard, normText } from '../episodes';
import { coverage } from '../cover';
import { cardDigest, updateCard } from './card';
import { sanitizeLine, weigh } from './file';
import { claimKey, opposed, sameClaims } from './claims';
import { deckExportMap, isProse, presentCards, renderLanes, withCards, withEdit, type DeckState } from './deck';
import { NEAR_DUPLICATE } from '../rooms';

export type FuseKind = 'exact' | 'near' | 'subsumed' | 'same-claims';

export interface FuseSuggestion {
  /** Stable id: the sorted member ids. */
  id: string;
  kind: FuseKind;
  members: string[];
  /** The fused text when the structured instructions match and one member keeps every protected word; else null and the player writes it. */
  autoText: string | null;
  /** A factual reason, for the preview. */
  why: string;
}

const EXCEPTION_WORDS = /\b(?:except|unless|other than|but only)\b/i;
const NEGATIONS = new Set(['no', 'not', 'never', "don't", 'without', 'avoid', 'only']);

/** Words a fused text must keep: negation, numbers and versions, paths and file names, and the whole exception clause. */
export function preservedTokens(text: string): Set<string> {
  const out = new Set<string>();
  const toks = contentTokens(text);
  for (const t of toks) if (NEGATIONS.has(t) || /\d/.test(t) || t.includes('/') || /\.[a-z0-9]{1,5}$/.test(t)) out.add(t);
  for (const m of text.matchAll(/\b(?:except|unless|other than|but only)\b[^.;]*/gi)) for (const t of contentTokens(m[0])) out.add(t);
  return out;
}

function scopeKey(s: Scope): string {
  return s.kind === 'global' ? 'global' : `project:${s.projectKey}`;
}

function anyOpposed(a: readonly Claim[] = [], b: readonly Claim[] = []): [Claim, Claim] | null {
  for (const x of a) for (const y of b) if (opposed(x, y)) return [x, y];
  return null;
}

/** Can these two cards be one card? Same scope, no opposed claims, and game cards must answer the same trigger. */
function compatible(a: Card, b: Card): boolean {
  if (scopeKey(a.scope) !== scopeKey(b.scope)) return false;
  if (anyOpposed(a.claims, b.claims)) return false;
  const game = (c: Card) => c.family !== 'imported';
  if (game(a) && game(b) && (JSON.stringify(a.trigger) !== JSON.stringify(b.trigger) || a.responseKey !== b.responseKey)) return false;
  if (a.type === 'skill' || b.type === 'skill') return a.type === b.type && a.skillSlug === b.skillSlug;
  return true;
}

function pairKind(a: Card, b: Card): { kind: FuseKind; why: string } | null {
  if (!compatible(a, b)) return null;
  if (normText(a.text) === normText(b.text)) return { kind: 'exact', why: 'the same words' };
  const ta = contentTokens(a.text);
  const tb = contentTokens(b.text);
  const j = jaccard(ta, tb);
  if (j >= NEAR_DUPLICATE) return { kind: 'near', why: `${Math.round(j * 100)}% of the content words match` };
  const [short, long] = ta.length <= tb.length ? [ta, b.text] : [tb, a.text];
  const longT = contentTokens(long);
  if (short.length > 0 && short.every((t) => longT.includes(t)) && EXCEPTION_WORDS.test(long)) return { kind: 'subsumed', why: 'the longer line says the same and adds an exception' };
  if (sameClaims(stripUnless(a.claims), stripUnless(b.claims))) return { kind: 'same-claims', why: 'matching structured claims · review wording' };
  return null;
}

function stripUnless(cs: readonly Claim[] = []): Claim[] {
  return cs.map(({ unless: _u, ...c }) => c);
}

/** Auto text: only when the structured instructions match; the shortest member that keeps every protected word. */
function autoText(cards: Card[]): string | null {
  const keys = cards.map((c) => new Set(stripUnless(c.claims).map(claimKey)));
  const allExact = cards.every((c) => normText(c.text) === normText(cards[0]!.text));
  // Structured instructions match only when every member has claims and they are the same set; empty claims prove nothing.
  const claimsMatch = keys[0]!.size > 0 && keys.every((k) => k.size === keys[0]!.size && [...k].every((x) => keys[0]!.has(x)));
  if (allExact) return cards[0]!.text; // the same words: keep the first line as written
  if (!claimsMatch) return null;
  const need = new Set<string>();
  for (const c of cards) for (const t of preservedTokens(c.text)) need.add(t);
  const fits = cards.filter((c) => {
    const toks = new Set(contentTokens(c.text));
    return [...need].every((t) => toks.has(t));
  });
  if (fits.length === 0) return null;
  return [...fits].sort((a, b) => a.text.length - b.text.length || a.text.localeCompare(b.text))[0]!.text;
}

/** Exact, near-duplicate, subsumed and same-instruction stacks among the cards present now. */
export function fuseSuggestions(d: DeckState): FuseSuggestion[] {
  const cards = presentCards(d).filter((c) => c.type !== 'trait');
  const parent = cards.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const why = new Map<number, { kind: FuseKind; why: string }[]>();
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const k = pairKind(cards[i]!, cards[j]!);
      if (!k) continue;
      parent[find(i)] = find(j);
      const list = why.get(i) ?? [];
      list.push(k);
      why.set(i, list);
    }
  }
  const comps = new Map<number, number[]>();
  cards.forEach((_, i) => {
    const r = find(i);
    comps.set(r, [...(comps.get(r) ?? []), i]);
  });
  const out: FuseSuggestion[] = [];
  for (const idx of comps.values()) {
    if (idx.length < 2) continue;
    const members = idx.map((i) => cards[i]!);
    // Every member must stay compatible with every other one, or the stack is declined.
    if (members.some((a, x) => members.some((b, y) => x < y && !compatible(a, b)))) continue;
    const kinds = idx.flatMap((i) => why.get(i) ?? []);
    const order: FuseKind[] = ['subsumed', 'same-claims', 'near', 'exact'];
    const kind = order.find((k) => kinds.some((w) => w.kind === k)) ?? 'exact';
    const sug: FuseSuggestion = { id: members.map((c) => c.id).sort().join('+'), kind, members: members.map((c) => c.id), autoText: autoText(members), why: [...new Set(kinds.map((w) => w.why))].join('; ') };
    // The same words already in each file (one line per file) are one shared card: merging would change nothing.
    if (sug.autoText !== null && isNoOp(d, sug)) continue;
    out.push(sug);
  }
  return out;
}

function isNoOp(d: DeckState, s: FuseSuggestion): boolean {
  const before = renderLanes(d);
  const after = renderLanes(applyFuse(d, s, s.autoText!));
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  return same(before.claude.next, after.claude.next) && same(before.codex.next, after.codex.next);
}

function targetsUnion(cards: Card[]): Targets {
  const s = new Set<string>();
  for (const c of cards) {
    if (c.targets === 'both') return 'both';
    s.add(c.targets);
  }
  return s.size > 1 ? 'both' : (([...s][0] ?? 'both') as Targets);
}

function exceptionsUnion(cards: Card[]): CardException[] {
  const out: CardException[] = [];
  const key = (e: CardException) => `${e.text}\u0000${JSON.stringify(Object.entries(e.when).sort())}`;
  for (const c of cards) for (const e of c.exceptions) if (!out.some((x) => key(x) === key(e))) out.push({ ...e, when: { ...e.when } });
  return out;
}

function evidenceUnion(cards: Card[]): Card['evidenceRefs'] {
  const out: Card['evidenceRefs'][number][] = [];
  for (const c of cards) for (const r of c.evidenceRefs) if (!out.some((x) => x.sessionId === r.sessionId && x.turn === r.turn && x.callId === r.callId)) out.push(r);
  return Object.freeze(out);
}

/** Perform a fuse. Prose stays prose: one survivor line per file is rewritten in place, the others are cut. */
export function applyFuse(d: DeckState, s: FuseSuggestion, text: string): DeckState {
  const t = sanitizeLine(text);
  if (!t) throw new Error('A fused card needs text.');
  const present = presentCards(d);
  const members = s.members.map((id) => present.find((c) => c.id === id)).filter((c): c is Card => !!c);
  if (members.length !== s.members.length) throw new Error('The stack changed; rebuild the suggestion.');
  if (members.some((a, x) => members.some((b, y) => x < y && !compatible(a, b)))) throw new Error('These cards no longer fit together (scope, trigger or claims changed); rebuild the suggestion.');
  let next = d;
  const games = members.filter((c) => !isProse(c));
  if (games.length === 0) {
    const files = new Set(members.map((c) => c.source!.file));
    for (const f of files) {
      const inFile = members.filter((c) => c.source!.file === f).sort((a, b) => a.source!.start - b.source!.start);
      const [survivor, ...rest] = inFile;
      const orig = d.imported.find((c) => c.id === survivor!.id)!;
      next = withEdit(next, survivor!.id, orig.text === t ? null : { kind: 'replace', text: t, exceptions: Object.freeze(exceptionsUnion(members)) });
      for (const r of rest) next = withEdit(next, r.id, { kind: 'cut' });
    }
    return next;
  }
  // A game card is involved: the result is a game card (managed line); prose members are cut.
  const base = games.find((c) => d.cards.some((g) => g.id === c.id)) ?? games[0]!;
  const fused = Object.freeze({ ...updateCard({ ...base, taken: true } as Card, { text: t, targets: targetsUnion(members), exceptions: exceptionsUnion(members) }), evidenceRefs: evidenceUnion(members) });
  const removed = new Set(d.removedManaged);
  for (const m of members) {
    if (isProse(m)) next = withEdit(next, m.id, { kind: 'cut' });
    else if (!d.cards.some((g) => g.id === m.id)) removed.add(m.id);
  }
  const cards = [...next.cards.filter((c) => !members.some((m) => m.id === c.id)), fused];
  return Object.freeze({ ...withCards(next, cards), removedManaged: Object.freeze([...removed]) });
}

// ------------------------------------------------------------------ previews

export interface Preview {
  before: { id: string; text: string; targets: Targets; scope: Scope }[];
  after: { text: string; targets: Targets; scope: Scope; trigger: Card['trigger'] | null; exceptions: CardException[]; retainedEvidence?: number } | null;
  weight: { claude: { before: number; after: number }; codex: { before: number; after: number } };
  /** Reviewed issue cases addressed before and after, and which ones the change opens or newly addresses. */
  cases: { before: number; after: number; confirmed: number; opened: string[]; addressed: string[] };
}

function addressedSet(d: DeckState, cases: readonly Case[]): { set: Set<string>; confirmed: number } {
  const lanes = renderLanes(d);
  const cov = coverage(presentCards(d), cases, deckExportMap(d, lanes));
  return { set: new Set([...cov.byCase.entries()].filter(([, v]) => v.length > 0).map(([k]) => k)), confirmed: cov.confirmed };
}

/** Preview any change: render both decks, weigh both files, compare coverage on the same reviewed cases. */
export function previewChange(before: DeckState, after: DeckState, cases: readonly Case[], focus?: { ids: string[]; resultId?: string }): Preview {
  const lb = renderLanes(before);
  const la = renderLanes(after);
  const cb = addressedSet(before, cases);
  const ca = addressedSet(after, cases);
  const pb = presentCards(before);
  const pa = presentCards(after);
  const beforeCards = focus ? pb.filter((c) => focus.ids.includes(c.id)) : [];
  const res = focus?.resultId ? pa.find((c) => c.id === focus.resultId) ?? null : null;
  return {
    before: beforeCards.map((c) => ({ id: c.id, text: c.text, targets: c.targets, scope: c.scope })),
    after: res ? { text: res.text, targets: res.targets, scope: res.scope, trigger: res.family === 'imported' ? null : res.trigger, exceptions: [...res.exceptions] } : null,
    weight: {
      claude: { before: weigh(lb.claude.next).total, after: weigh(la.claude.next).total },
      codex: { before: weigh(lb.codex.next).total, after: weigh(la.codex.next).total },
    },
    cases: { before: cb.set.size, after: ca.set.size, confirmed: ca.confirmed, opened: [...cb.set].filter((x) => !ca.set.has(x)), addressed: [...ca.set].filter((x) => !cb.set.has(x)) },
  };
}

/** Preview a fuse: the result shown as one card with the union of targets (a shared card weighs on both meters). */
export function previewFuse(d: DeckState, s: FuseSuggestion, text: string, cases: readonly Case[]): Preview {
  const after = applyFuse(d, s, text);
  const p = previewChange(d, after, cases, { ids: s.members });
  const members = presentCards(d).filter((c) => s.members.includes(c.id));
  const pa = presentCards(after);
  const result = pa.find((c) => s.members.includes(c.id) || (!members.some((m) => m.id === c.id) && !presentCards(d).some((x) => x.id === c.id))) ?? null;
  p.after = { text: sanitizeLine(text), targets: targetsUnion(members), scope: members[0]!.scope, trigger: result && result.family !== 'imported' ? result.trigger : null, exceptions: exceptionsUnion(members), retainedEvidence: evidenceUnion(members).length };
  return p;
}

// ------------------------------------------------------------------ conflicts

export interface Conflict {
  /** Stable id: the two card ids, sorted. */
  id: string;
  a: string;
  b: string;
  claimA: Claim;
  claimB: Claim;
  /** Plain words for the red link. */
  text: string;
}

function targetsMeet(a: Targets, b: Targets): boolean {
  return a === 'both' || b === 'both' || a === b;
}

function scopesMeet(a: Card, b: Card): boolean {
  if (a.scope.kind === 'project' && b.scope.kind === 'project') return a.scope.projectKey === b.scope.projectKey;
  return true;
}

/** An exception on one card that removes the other card's project. */
function separated(a: Card, b: Card): boolean {
  // Only an exception whose whole predicate is the project removes that project; extra conditions leave an overlap.
  const cut = (x: Card, y: Card) =>
    y.scope.kind === 'project' && x.exceptions.some((e) => e.when.projectKey === (y.scope as { projectKey: string }).projectKey && e.when.pathPrefix === undefined && e.when.commandPrefix === undefined);
  return cut(a, b) || cut(b, a);
}

/** A written exception resolves a red link only for the two cards exactly as they were when it was written. */
function resolutionKey(a: Card, b: Card): string {
  const [x, y] = [a, b].sort((p, q) => p.id.localeCompare(q.id));
  return `${x.id}@${cardDigest(x)}×${y.id}@${cardDigest(y)}`;
}

/** Red links: opposed actions under overlapping conditions, for the same agent, in overlapping scopes. */
export function conflicts(d: DeckState): Conflict[] {
  const cards = presentCards(d).filter((c) => c.type !== 'trait');
  const out: Conflict[] = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]!;
      const b = cards[j]!;
      if (!targetsMeet(a.targets, b.targets) || !scopesMeet(a, b) || separated(a, b)) continue;
      if (d.resolvedPairs?.includes(resolutionKey(a, b))) continue;
      const pair = anyOpposed(a.claims, b.claims);
      if (!pair) continue;
      const [x, y] = pair;
      out.push({ id: [a.id, b.id].sort().join('×'), a: a.id, b: b.id, claimA: x, claimB: y, text: `One card says ${x.polarity === 'do' ? 'to' : 'not to'} ${x.act} ${x.object.replace(/^[a-z]+:/, '')}${x.when ? ` (${x.when})` : ''}; the other says ${y.polarity === 'do' ? 'to' : 'not to'}.` });
    }
  }
  return out;
}

export type Resolution =
  /** Keep one card; the other is cut. */
  | { kind: 'keep'; keep: string }
  /** Separate the conditions: `bind` applies only in the project; the other card gains a visible exception for it. */
  | { kind: 'separate'; bind: string; projectKey: string; projectLabel: string }
  /** Write an explicit exception on one card (visible text plus its structured condition). */
  | { kind: 'exception'; on: string; text: string; when: CardException['when'] }
  /** Cancel: a card taken this run is put back on the shelf; otherwise nothing changes and the link stays red. */
  | { kind: 'cancel' };

function withText(d: DeckState, c: Card, text: string, patch: { scope?: Scope; exceptions?: CardException[] }): DeckState {
  if (isProse(c)) {
    const prior = d.edits[c.id];
    const priorEx = prior?.kind === 'replace' ? prior.exceptions : undefined;
    return withEdit(d, c.id, { kind: 'replace', text: sanitizeLine(text), ...(patch.scope ? { scope: patch.scope } : {}), exceptions: Object.freeze(patch.exceptions ?? [...(priorEx ?? c.exceptions)]) });
  }
  const game = d.cards.find((g) => g.id === c.id) ?? ({ ...c, taken: true } as Card);
  const next = updateCard(game, { text, ...(patch.scope ? { scope: patch.scope } : {}), ...(patch.exceptions ? { exceptions: patch.exceptions } : {}) }, sanitizeLine);
  const removed = d.cards.some((g) => g.id === c.id) ? d.removedManaged : [...d.removedManaged];
  return Object.freeze({ ...withCards(d, [...d.cards.filter((g) => g.id !== c.id), next]), removedManaged: Object.freeze(removed) });
}

/** Remove a card from the deck. Prose and managed lines are cut from their file; game cards leave the proposal. */
export function removeCard(d: DeckState, id: string): DeckState {
  const c = presentCards(d).find((x) => x.id === id);
  if (!c) return d;
  if (isProse(c)) return withEdit(d, id, { kind: 'cut' });
  if (d.cards.some((g) => g.id === id)) return withCards(d, d.cards.filter((g) => g.id !== id));
  return Object.freeze({ ...d, removedManaged: Object.freeze([...d.removedManaged, id]) });
}

const stripStop = (t: string) => t.trim().replace(/[\s.]+$/, '');
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

export function resolveConflict(d: DeckState, c: Conflict, r: Resolution): DeckState {
  const present = presentCards(d);
  const A = present.find((x) => x.id === c.a);
  const B = present.find((x) => x.id === c.b);
  if (!A || !B) return d;
  switch (r.kind) {
    case 'keep':
      return removeCard(d, r.keep === A.id ? B.id : A.id);
    case 'separate': {
      const bound = r.bind === A.id ? A : B;
      const other = bound === A ? B : A;
      const scope: Scope = { kind: 'project', projectKey: r.projectKey, label: r.projectLabel };
      // Any earlier project clause is replaced, so the exported text always names the scope the card now has.
      const bare = bound.text.replace(/^In [^,]{1,80}, /, '');
      const boundText = `In ${r.projectLabel}, ${lowerFirst(bare)}`;
      let next = withText(d, bound, boundText, { scope });
      const ex: CardException = { text: `except in ${r.projectLabel}`, when: { projectKey: r.projectKey } };
      next = withText(next, presentCards(next).find((x) => x.id === other.id)!, `${stripStop(other.text)}, except in ${r.projectLabel}.`, { exceptions: [...other.exceptions, ex] });
      return next;
    }
    case 'exception': {
      // The player's written exception says the two coexist: it shows in the text and resolves this red link.
      const on = r.on === A.id ? A : B;
      const ex: CardException = { text: sanitizeLine(r.text), when: { ...r.when } };
      const next = withText(d, on, `${stripStop(on.text)}, ${lowerFirst(stripStop(ex.text))}.`, { exceptions: [...on.exceptions, ex] });
      const pa = presentCards(next).find((x) => x.id === A.id)!;
      const pb = presentCards(next).find((x) => x.id === B.id)!;
      return Object.freeze({ ...next, resolvedPairs: Object.freeze([...(next.resolvedPairs ?? []), resolutionKey(pa, pb)]) });
    }
    case 'cancel': {
      const fresh = [A, B].find((x) => d.cards.some((g) => g.id === x.id));
      return fresh ? withCards(d, d.cards.filter((g) => g.id !== fresh.id)) : d;
    }
  }
}

// ------------------------------------------------------------------ cut and sharpen

/** Cut a card and report the coverage it takes with it (reviewed issue cases no longer addressed). */
export function cutCard(d: DeckState, id: string, cases: readonly Case[]): { deck: DeckState; coverageLost: string[]; preview: Preview } {
  const next = removeCard(d, id);
  const preview = previewChange(d, next, cases, { ids: [id] });
  return { deck: next, coverageLost: preview.cases.opened, preview };
}

/** Sharpen: tighten the text. A game card's digest changes, so every mapping must be accepted again. */
export function sharpen(d: DeckState, id: string, text: string): DeckState {
  const c = presentCards(d).find((x) => x.id === id);
  if (!c) return d;
  return withText(d, c, text, {});
}

/** Imported report lines that a verified workflow can sharpen into a result-bearing summary. */
export function sharpenSuggestions(d: DeckState, workflowVerified: boolean): { id: string; from: string; to: string }[] {
  if (!workflowVerified) return [];
  return presentCards(d)
    .filter((c) => c.family === 'imported' && (c.claims ?? []).some((x) => x.act === 'report' && x.object === 'result-summary') && !/pass count|test result/i.test(c.text))
    .map((c) => ({ id: c.id, from: c.text, to: `${stripStop(c.text)}, with the test result and its pass count.` }));
}

/** The card's mapping is current only while its digest matches what the player accepted. */
export function mappingCurrent(c: Card, caseId: string): boolean {
  return c.acceptedMappings[caseId] === cardDigest(c);
}
