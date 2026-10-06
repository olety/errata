// The play loop's operations on the engine (play-loop §2, §3, §5, §9, §14 and the §0a amendments). Pure functions from
// one deck state to the next. Previews never bind: a drop updates the proposal and the accepted mappings, then the
// ordinary eight-check cover() decides what is bound, and only its true results are reported (§0a.2).
// The UI reaches these through src/ui/playloop/adapter.ts only.

import type { Agent } from './model';
import type { Card, Case, Disposition, ExportMap, Targets } from './deck/types';
import { CHECKS, cover, coverage, coverPreview, openCases, type Check, type CoverPreview, type CoverResult, type Tri } from './cover';
import { setTaken, updateCard } from './deck/card';
import { acceptOnCase, deckExportMap, isProse, newDeck, presentCards, renderLanes, suggestMapping, withCards, type DeckState } from './deck/deck';
import { lineWeight, parseGlobal, weigh } from './deck/file';
import type { LaneResult } from './deck/lanes';

/** Where a card can be dropped in a room. A head drop for an in-deck card goes through acceptOnHead. */
export type DropTarget = 'beast' | 'claude' | 'codex';

const AGENTS: readonly Agent[] = ['claude', 'codex'];

function unionTargets(agents: Iterable<Agent>): Targets | null {
  const s = new Set(agents);
  if (s.size === 0) return null;
  return s.size === 2 ? 'both' : [...s][0]!;
}

function includes(t: Targets, a: Agent): boolean {
  return t === 'both' || t === a;
}

/**
 * The targets a card would carry after a drop on `target`. A beast drop previews with the card's displayed targets.
 * A book drop puts a new card in that file only; a card already in the other book is widened to both (§3).
 */
export function dropTargets(card: Card, target: DropTarget, inDeck?: Card): Targets {
  if (target === 'beast') return (inDeck ?? card).targets;
  if (!inDeck) return target;
  return includes(inDeck.targets, target) ? inDeck.targets : 'both';
}

/** The deck with this card in the proposal for these targets (it replaces any copy already there). */
export function withProposed(d: DeckState, card: Card, targets: Targets): DeckState {
  const base = d.cards.find((g) => g.id === card.id) ?? card;
  const k = setTaken(base.targets === targets ? base : updateCard(base, { targets }), true);
  return withCards(d, [...d.cards.filter((g) => g.id !== card.id), k]);
}

/** The export map as the rendered proposal would carry it with this card added for these targets. */
export function prospectiveExport(d: DeckState, card: Card, targets: Targets): ExportMap {
  const next = withProposed(d, card, targets);
  return deckExportMap(next, renderLanes(next));
}

// ------------------------------------------------------------------ weight (§5, §14.10, §0a.9)

export interface WeightLane {
  /** Whole-file estimated tokens before and after, from rendering both decks. */
  before: number;
  after: number;
  delta: number;
  /** The managed lines added minus those removed, each by lineWeight. */
  line: number;
  /** On the first managed card in a file (or removing the last one): everything else the block brings, separator included. */
  blockHeader: number;
  /** The rest of the delta: protected-text edits and per-block rounding. */
  other: number;
  firstManaged: boolean;
  allowance: number;
  over: boolean;
}

export interface WeightPreview {
  claude: WeightLane;
  codex: WeightLane;
  /** Every token figure is an estimate (UTF-8 bytes ÷ 3, by block). */
  estimated: true;
}

function weightLane(b: LaneResult, a: LaneResult): WeightLane {
  const before = weigh(b.next).total;
  const after = weigh(a.next).total;
  const pb = parseGlobal(b.next);
  const pa = parseGlobal(a.next);
  const key = (l: { id: string; text: string }) => `${l.id}\u0000${l.text}`;
  const bk = new Set(pb.managed.map(key));
  const ak = new Set(pa.managed.map(key));
  const line = pa.managed.filter((l) => !bk.has(key(l))).reduce((s, l) => s + lineWeight(l.text, l.id), 0) - pb.managed.filter((l) => !ak.has(key(l))).reduce((s, l) => s + lineWeight(l.text, l.id), 0);
  const firstManaged = !pb.block && !!pa.block;
  const lastManaged = !!pb.block && !pa.block;
  const delta = after - before;
  // A section heading the block gains or loses (the first Skill card brings "## Reusable workflows") is header text
  // too: the remainder is attributed to the block header, never left as an unnamed "other" (P3 cold-player flag).
  const headings = (b: Uint8Array) => (new TextDecoder().decode(b).match(/^## (?:Reviewed working rules|Reusable workflows)\s*$/gm) ?? []).length;
  const headingChange = !firstManaged && !lastManaged && headings(b.next) !== headings(a.next);
  const blockHeader = firstManaged || lastManaged || headingChange ? delta - line : 0;
  return { before, after, delta, line, blockHeader, other: delta - line - blockHeader, firstManaged, allowance: a.allowance, over: after > a.allowance };
}

/** Per-lane weight change between two decks, from rendering both lanes of each. */
export function weightPreview(before: DeckState, after: DeckState): WeightPreview {
  const lb = renderLanes(before);
  const la = renderLanes(after);
  return { claude: weightLane(lb.claude, la.claude), codex: weightLane(lb.codex, la.codex), estimated: true };
}

// ------------------------------------------------------------------ drop preview and play (§2 step 4, §3, §0a.2–5)

export interface HeadPreview {
  caseId: string;
  agent: Agent;
  preview: CoverPreview;
}

export interface DropPreview {
  target: DropTarget;
  /** The targets the glow was computed with. */
  targets: Targets;
  heads: HeadPreview[];
  /** Case ids that glow: checks 1 and 3–7 true against the prospective export. */
  eligible: string[];
  /** What a release would export to; null when the drop is refused. A beast drop exports to the glowing heads' agents. */
  finalTargets: Targets | null;
  /** Why a release would be refused (a beast drop with no eligible head); the pick is not spent. */
  refused: string | null;
  /** The exact line as it would land, and the files it would land in. */
  line: string;
  destinations: Agent[];
  /** Per-lane weight change for the release; all zero when refused. */
  weight: WeightPreview;
}

export const NO_ELIGIBLE_HEAD = 'No head here is eligible for this card. Drop it on a book to add it anyway, or on the shelf to skip.';

/** What a drop of `card` on `target` would do to these heads. Nothing binds here. */
export function previewDrop(d: DeckState, card: Card, heads: readonly Case[], target: DropTarget): DropPreview {
  const inDeck = d.cards.find((g) => g.id === card.id);
  const targets = dropTargets(card, target, inDeck);
  const ex = prospectiveExport(d, card, targets);
  const hp = heads.map((c) => ({ caseId: c.id, agent: c.agent, preview: coverPreview(card, c, ex, targets) }));
  const eligible = hp.filter((h) => h.preview.eligible).map((h) => h.caseId);
  const finalTargets = target === 'beast' ? unionTargets(hp.filter((h) => h.preview.eligible).map((h) => h.agent)) : targets;
  const refused = finalTargets === null ? NO_ELIGIBLE_HEAD : null;
  const after = finalTargets ? withProposed(d, card, finalTargets) : d;
  const exAfter = deckExportMap(after, renderLanes(after));
  return {
    target,
    targets,
    heads: hp,
    eligible,
    finalTargets,
    refused,
    line: (inDeck ?? card).text,
    destinations: finalTargets ? AGENTS.filter((a) => exAfter[a].has(card.id)) : [],
    weight: weightPreview(d, after),
  };
}

export interface HeadResult {
  caseId: string;
  /** The ordinary eight-check result for the played card. */
  result: CoverResult;
  /** Some card in the proposed export covers this head now. */
  bound: boolean;
}

export interface PlayResult {
  deck: DeckState;
  /** The card as it now stands in the proposal; null when refused. */
  card: Card | null;
  /** Case ids whose mapping this drop accepted: the glowing heads only. */
  accepted: string[];
  results: HeadResult[];
  refused: string | null;
}

/** True cover results for every head against the deck as it stands. */
export function headResults(d: DeckState, heads: readonly Case[], cardId: string | null): HeadResult[] {
  const cards = presentCards(d);
  const ex = deckExportMap(d, renderLanes(d));
  const played = cardId ? cards.find((c) => c.id === cardId) : undefined;
  return heads.map((c) => ({
    caseId: c.id,
    result: played ? cover(played, c, ex) : { covers: false, checks: Object.fromEntries(CHECKS.map((k) => [k, 'false'])) as Record<Check, Tri> },
    bound: cards.some((k) => cover(k, c, ex).covers),
  }));
}

/**
 * Play a card onto a target. The proposal gains the card for the final targets, the drop accepts the mapping for
 * each glowing head and nothing else, then the ordinary cover() reports what is bound. A beast drop with no glowing
 * head is refused and the deck is returned unchanged. Dispositions are never touched here: they come from stamps.
 */
export function playCard(d: DeckState, card: Card, heads: readonly Case[], target: DropTarget): PlayResult {
  const pv = previewDrop(d, card, heads, target);
  if (!pv.finalTargets) return { deck: d, card: null, accepted: [], results: headResults(d, heads, null), refused: pv.refused };
  let next = withProposed(d, card, pv.finalTargets);
  for (const id of pv.eligible) next = acceptOnCase(next, card.id, id);
  return { deck: next, card: next.cards.find((g) => g.id === card.id) ?? null, accepted: pv.eligible, results: headResults(next, heads, card.id), refused: null };
}

/**
 * Re-target a card already in the proposal (a book drop at the fire, or the inspector's target chips). Earlier
 * acceptances stay and no new ones are made (§14.2). Imported prose lives in its own file and cannot be re-targeted.
 */
export function retarget(d: DeckState, cardId: string, targets: Targets): { deck: DeckState; refused: string | null } {
  const g = d.cards.find((x) => x.id === cardId);
  if (!g) {
    const present = presentCards(d).find((x) => x.id === cardId);
    return { deck: d, refused: present && isProse(present) ? 'A line from your file stays in that file. Merge it with a card to share it.' : 'This card is not in the proposal.' };
  }
  return { deck: withProposed(d, g, targets), refused: null };
}

/** A card already in the proposal dropped on one head: accept the mapping when checks 1 and 3–7 hold (§3). */
export function acceptOnHead(d: DeckState, cardId: string, head: Case): { deck: DeckState; preview: CoverPreview | null; refused: string | null } {
  const card = presentCards(d).find((c) => c.id === cardId);
  if (!card) return { deck: d, preview: null, refused: 'This card is not in the proposal.' };
  const ex = deckExportMap(d, renderLanes(d));
  const preview = coverPreview(card, head, ex, card.targets);
  if (!preview.eligible) return { deck: d, preview, refused: null };
  return { deck: acceptOnCase(d, cardId, head.id), preview, refused: null };
}

// ------------------------------------------------------------------ the Open pile (§0a.7)

/** Confirmed cases with no covering card in the current proposal, as a set of case ids. */
export function openPile(d: DeckState, reviewed: readonly Case[]): string[] {
  return openCases(presentCards(d), reviewed, deckExportMap(d, renderLanes(d)));
}

// ------------------------------------------------------------------ the boss (§9, §14.8, §0a.11–12)

/** The checks a boss candidate must pass to glow: 2 to 7. Check 1 is the blind stamp; check 8 is the answer drag. */
export const BOSS_CHECKS = ['in_export', 'targets_agent', 'scope_matches', 'trigger_true', 'response_eligible', 'exceptions_clear'] as const satisfies readonly Check[];

export interface BossCandidate {
  cardId: string;
  eligible: boolean;
  /** The first failing check among 2 to 7, null when eligible. */
  failing: { check: Check; tri: Tri } | null;
}

/** Every deck card against one boss head, with its first failing check. */
export function bossCandidates(d: DeckState, head: Case): BossCandidate[] {
  const ex = deckExportMap(d, renderLanes(d));
  return presentCards(d)
    .filter((c) => c.type !== 'trait')
    .map((c) => {
      const r = cover(c, head, ex);
      const first = BOSS_CHECKS.find((k) => r.checks[k] !== 'true');
      return { cardId: c.id, eligible: !first, failing: first ? { check: first, tri: r.checks[first] } : null };
    });
}

/** The answer drag at the boss: accept the mapping of an eligible card for a head stamped a problem. No new cards, no edits. */
export function answerBoss(d: DeckState, cardId: string, head: Case): { deck: DeckState; refused: string | null } {
  if (head.disposition !== 'issue') return { deck: d, refused: 'Only a head stamped a problem takes an answer.' };
  const cand = bossCandidates(d, head).find((c) => c.cardId === cardId);
  if (!cand) return { deck: d, refused: 'This card is not in the proposal.' };
  if (!cand.eligible) return { deck: d, refused: null };
  return { deck: acceptOnCase(d, cardId, head.id), refused: null };
}

function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A digest of everything a tally depends on: both rendered files, every card's accepted mappings, the imported-line
 * acceptances and the settlements. A locked score is keyed to this; any later change makes the tally stale (§0a.12).
 */
export function deckRevision(d: DeckState): string {
  const L = renderLanes(d);
  let h = 0x811c9dc5;
  for (const b of [L.claude.next, L.codex.next]) {
    h = fnv(String(b.length), h);
    for (let i = 0; i < b.length; i++) {
      h ^= b[i]!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  const acc = presentCards(d)
    .map((c) => `${c.id}:${c.targets}:${Object.entries(c.acceptedMappings).sort().map(([k, v]) => `${k}=${v}`).join(',')}`)
    .sort()
    .join('|');
  h = fnv(acc, h);
  h = fnv(JSON.stringify(d.acceptedImports ?? {}), h);
  h = fnv((d.settlements ?? []).map((s) => s.key).sort().join('|'), h);
  return h.toString(16).padStart(8, '0');
}

export interface BossHead {
  caseId: string;
  disposition: Disposition;
  addressed: boolean;
  coveredBy: string[];
  candidates: BossCandidate[];
  /** A problem with no candidate passing checks 2 to 7: "No eligible card", with each candidate's reason. */
  noEligibleCard: boolean;
}

export interface BossTally {
  /** deckRevision() the tally was computed on. */
  revision: string;
  heads: BossHead[];
  /** Withheld cases stamped a problem, addressed by the final deck (one pip per family per session). */
  later: { addressed: number; confirmed: number };
  /** Every set-aside disposition, printed beside the score (§0a.11). */
  setAside: { notAProblem: number; changeOfPlan: number; unclear: number };
  unreviewed: number;
  /** The earlier reviewed cases against the final deck, and those still open. */
  earlier: { addressed: number; confirmed: number; open: string[] };
  /**
   * The original files on the same reviewed cohort (§0a.11). Counts only imported lines whose per-case mapping the
   * player accepted; `unknown` = imported lines with a suggested mapping never judged; `established` is false when
   * no original-file mapping was accepted at all ("applicability not established").
   */
  original: { addressed: number; confirmed: number; unknown: number; established: boolean };
}

/** The boss score on the deck as it stands. Lock it by keeping the revision; tallyCurrent() says when it is stale. */
export function bossTally(d: DeckState, withheld: readonly Case[], earlier: readonly Case[]): BossTally {
  const cards = presentCards(d);
  const ex = deckExportMap(d, renderLanes(d));
  const heads: BossHead[] = withheld.map((c) => {
    const coveredBy = cards.filter((k) => cover(k, c, ex).covers).map((k) => k.id);
    const candidates = bossCandidates(d, c);
    return { caseId: c.id, disposition: c.disposition, addressed: coveredBy.length > 0, coveredBy, candidates, noEligibleCard: c.disposition === 'issue' && !candidates.some((x) => x.eligible) };
  });
  const later = coverage(cards, withheld, ex);
  const ear = coverage(cards, earlier, ex);
  const count = (x: Disposition) => withheld.filter((c) => c.disposition === x).length;
  // The original files, with only the acceptances the player gave to their own lines.
  const o = d.originals;
  const base: DeckState = Object.freeze({ ...newDeck(o.claude, o.codex, o.codexOverride), ...(d.acceptedImports ? { acceptedImports: d.acceptedImports } : {}), ...(d.importCaseMappings ? { importCaseMappings: d.importCaseMappings } : {}) });
  const cohort = [...earlier, ...withheld];
  const orig = coverage(presentCards(base), cohort, deckExportMap(base, renderLanes(base)));
  const accepted = new Set(Object.keys(d.importCaseMappings ?? {}));
  const unknown = base.imported.filter((c) => suggestMapping(c.text).responseKey !== 'unmapped' && !accepted.has(c.id) && d.acceptedImports?.[c.id] === undefined).length;
  return {
    revision: deckRevision(d),
    heads,
    later: { addressed: later.addressed, confirmed: later.confirmed },
    setAside: { notAProblem: count('not-a-problem'), changeOfPlan: count('pivot'), unclear: count('unclear') },
    unreviewed: count('unreviewed'),
    earlier: { addressed: ear.addressed, confirmed: ear.confirmed, open: openCases(cards, earlier, ex) },
    original: { addressed: orig.addressed, confirmed: orig.confirmed, unknown, established: accepted.size > 0 },
  };
}

/** A locked tally holds only for the deck revision it was computed on. */
export function tallyCurrent(t: Pick<BossTally, 'revision'>, d: DeckState): boolean {
  return t.revision === deckRevision(d);
}
