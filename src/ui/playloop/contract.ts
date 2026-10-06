// The play loop's shared contract (play-loop v2 with the §0a amendments). FROZEN for the four workers: cards/layout,
// room/rig, campfire, boss/apply. Workers import types and pure selectors from here, read views from the adapter's
// select* functions, and raise intents through the controller. Nothing in this file touches the engine; every number
// in a view was computed by src/ui/playloop/adapter.ts, which names its honesty-map source (§13) in a JSDoc line.
// Change this file only through the integrator; CONTRACT.md lists who consumes what.

// ------------------------------------------------------------------ basics

export type Agent = 'claude' | 'codex';
export type Targets = Agent | 'both';
export type FileName = 'CLAUDE.md' | 'AGENTS.md';

/** The four stamps (§2, §0a.6). "unclear" leaves the head wrapped and counts nowhere. */
export type Stamp = 'issue' | 'pivot' | 'not-a-problem' | 'unclear';
export type Disposition = Stamp | 'unreviewed';

export const STAMPS: readonly { stamp: Stamp; label: string; key: string }[] = [
  { stamp: 'issue', label: 'A problem', key: 'a' },
  { stamp: 'pivot', label: 'A change of plan', key: 'c' },
  { stamp: 'not-a-problem', label: 'Not a problem', key: 'n' },
  { stamp: 'unclear', label: 'Unclear · leave wrapped', key: 'u' },
];

/** The checks of the cover rule, in order (§3 of mechanics v1). */
export type Check = 'confirmed_issue' | 'in_export' | 'targets_agent' | 'scope_matches' | 'trigger_true' | 'response_eligible' | 'exceptions_clear' | 'mapping_accepted';
export type Tri = 'true' | 'false' | 'unknown';

export const FILE_OF: Record<Agent, FileName> = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };
export const AGENT_NAME: Record<Agent, string> = { claude: 'Claude', codex: 'Codex' };

/** Copy that must read the same everywhere. */
export const COPY = {
  proposed: 'Proposed',
  addsTo: 'adds to your proposed files',
  tutorialFiles: 'Instructions become cards; other text stays protected.',
  estimated: 'estimated',
  excerpt: 'Excerpt · inspect full line',
  ifAccepted: 'if added to these files and accepted',
  finalizes: 'Playing a card or skipping finalizes your stamps for this room.',
  pullBack: 'Pull the hand back to change a stamp.',
  noEligibleCard: 'No eligible card',
  applicabilityUnknown: 'No accepted original-file mapping · applicability not established',
  footer: 'Saved for future sessions. This game did not test whether an agent follows these instructions.',
  sample: 'synthetic sample',
} as const;

// ------------------------------------------------------------------ receipts and heads (room/rig worker)

export interface ReceiptView {
  caseId: string;
  /** The human's words, or null: render COPY-free "Tool evidence only". */
  quote: string | null;
  pasted: boolean;
  action: string | null;
  result: string | null;
  then: string | null;
  agent: Agent;
  project: string | null;
  /** YYYY-MM-DD, or null when the log had no time. */
  date: string | null;
}

/**
 * wrapped = no stamp or "unclear" (cannot bind, not counted) · bared = a problem, not yet answered · bound = some card
 * in the proposed export passes all eight checks · standing = a problem left unbound after the room's play ·
 * heron = a change of plan · sunk = not a problem · lantern = a verified workflow session at the Workshop (a success,
 * never a problem; it is not stamped and counts nowhere).
 */
export type HeadState = 'wrapped' | 'bared' | 'bound' | 'standing' | 'heron' | 'sunk' | 'lantern';

export interface HeadView {
  caseId: string;
  state: HeadState;
  disposition: Disposition;
  tag: { agent: Agent; project: string | null; date: string | null };
  /** Neck rings: repeats inside this one case, and what they count. Null on families that draw none. */
  rings: { count: number; counts: 'failed runs' | 'edits' } | null;
  /** 0–4 for the five drawn heads; null for heads behind the overflow knot. */
  socket: number | null;
  receipt: ReceiptView;
}

export interface OverflowView {
  more: number;
  bound: number;
  unreviewed: number;
  /** "N more · a bound · u unreviewed" */
  text: string;
}

export interface PipsView {
  addressed: number;
  confirmed: number;
  unreviewed: number;
  /** "3/3 confirmed addressed · 2 unreviewed", or "No confirmed problems · 2 unreviewed". Never "0/0". */
  text: string;
  /** Only a room with confirmed problems, all addressed and none unreviewed, gets the fully-addressed animation. */
  fully: boolean;
}

export type Skin = 'suite-wyrm' | 'retry-hydra' | 'boundary-stag' | 'patch-moth' | 'owl' | 'heron';

export interface BeastView {
  roomKey: string;
  skin: Skin;
  name: string;
  subtitle: string;
  /** The five drawn heads (sockets 0–4). */
  heads: HeadView[];
  overflow: OverflowView | null;
  pips: PipsView;
}

// ------------------------------------------------------------------ cards, books, piles (cards/layout worker)

export interface CardFaceView {
  /** ≤ 20 characters. */
  title: string;
  /** ≤ 64 visible characters. Inline `code` spans are marked with backticks. */
  summary: string;
  mode: 'exact' | 'summary' | 'excerpt';
  /** COPY.excerpt when the face is a clamped excerpt. */
  mark: string | null;
}

export interface CardInspectorView {
  /** The exact line as it will land in the file. */
  exact: string;
  targets: Targets;
  scope: string;
  trigger: string | null;
  exceptions: string[];
  /** "138 bytes ÷ 3 = 46" */
  weightMath: string;
  quote: string | null;
  evidence: { agent: Agent; date: string | null; sessionLabel: string }[];
  /** Imported or edited lines whose mapping the player must accept from the inspector. */
  needsAcceptance: boolean;
  /** Skills: the first lines of the SKILL.md body and its estimate, outside the allowance. */
  skill: { firstLines: string[]; estimate: number } | null;
  /** Not dealt: why (per-case ineligibility reasons). */
  unavailable: string[];
}

export interface CardView {
  id: string;
  type: 'rule' | 'skill' | 'protected' | 'trait';
  face: CardFaceView;
  /** The weight orb: the card's own line weight, estimated tokens. */
  weight: number;
  targets: Targets;
  sigils: { claude: boolean; codex: boolean };
  /** "global" or the project chip. */
  scope: string;
  exceptions: string[];
  /** Observed · Repeated · n · Verified. Never adds power. */
  provenance: string;
  /** Rooms only: "n eligible here · m newly addressed", counted against the card's displayed targets. */
  footer: { eligible: number; newly: number; text: string } | null;
  /** The files that carry this card in the proposal now (empty for a draft). */
  inFiles: Agent[];
  inspector: CardInspectorView;
}

export interface GhostDelta {
  before: number;
  after: number;
  delta: number;
  line: number;
  blockHeader: number;
  other: number;
  /** "+46 line · +22 block header", "−15", or "no change"; always with COPY.estimated beside it. */
  text: string;
}

export interface BookView {
  lane: Agent;
  file: FileName;
  /** ~/.claude/CLAUDE.md or ~/.codex/AGENTS.md */
  path: string;
  /** The Proposed watermark stays until a verified Apply (§0a.1). */
  proposed: boolean;
  loaded: boolean;
  weight: { now: number; allowance: number; over: boolean; noGrowth: boolean; raisedBy: number | null };
  /** Why this lane cannot be written (an active Codex override), or null. */
  blocked: string | null;
  cardIds: string[];
}

export interface OpenPageView {
  caseId: string;
  roomKey: string;
  tag: { agent: Agent; project: string | null; date: string | null };
  receipt: ReceiptView;
}

export interface PilesView {
  /** Drafted and not taken. Never written; returns only as a swap at the fire. */
  shelf: CardView[];
  /** A set keyed by case id: confirmed cases with no coverage in the current proposal (§0a.7). Never a drop target. */
  open: OpenPageView[];
}

export interface RouteKnotView {
  slot: number;
  kind: 'encounter' | 'event' | 'campfire' | 'elite' | 'review' | 'workshop' | 'card-review' | 'boss' | 'audit' | 'apply';
  label: string;
  state: 'done' | 'current' | 'ahead';
  open: number;
  unreviewed: number;
  heads: number;
  sigils: Agent[];
}

export interface RouteView {
  knots: RouteKnotView[];
  current: number;
  /** The boss's held-back cases: a count and agent sigils only. No family, project or words (§5.5). */
  sealed: { count: number; sigils: Agent[] };
}

export interface StatusView {
  sample: boolean;
  /** "synthetic sample · 12 sessions" */
  text: string;
}

// ------------------------------------------------------------------ the room

/** judge → stamps open; dealt → hand on the wood, stamps still changeable by pulling the hand back; done → final. */
export type RoomPhase = 'judge' | 'dealt' | 'done';

export interface RoomView {
  kind: 'encounter' | 'event' | 'workshop';
  roomKey: string;
  beast: BeastView;
  /** Every selected head in the room, the drawn five first. */
  heads: HeadView[];
  /** One complete receipt at a time, with a visible queue (§0a.13). */
  receipts: { current: ReceiptView | null; queue: string[] };
  phase: RoomPhase;
  /** Dealt drafts with observed eligibility only (§0a.4). Empty before dealing. */
  hand: CardView[];
  /** Drafts not dealt, with their reasons, for the inspector. */
  unavailable: CardView[];
  books: BookView[];
  piles: PilesView;
  route: RouteView;
  status: StatusView;
  /** COPY.finalizes while dealt; the UI says which action finalizes. */
  finalizes: string | null;
  canDeal: boolean;
  /** Offer Continue at once when every judged head is set aside, or Keep existing when imported lines cover all (§0a.14). */
  offer: 'continue-all-set-aside' | 'keep-existing' | null;
  /** An already-imported line that passes checks 3–7 for a bared head asks "Already in your file. Does it answer this case?" */
  existingAsks: { cardId: string; caseId: string; line: string }[];
  /** The room's result after its play or skip. */
  result: PlayResultView | null;
}

// ------------------------------------------------------------------ drag (integrator: drag.ts; every worker renders targets)

export type DragTarget =
  | { kind: 'beast' }
  | { kind: 'book'; lane: Agent }
  | { kind: 'shelf' }
  | { kind: 'head'; caseId: string }
  | { kind: 'card'; cardId: string }
  | { kind: 'fire' }
  | { kind: 'book-retarget'; lane: Agent };

export interface HeadGlow {
  caseId: string;
  /** Checks 1 and 3–7 hold against the prospective export for this target: conditional eligibility, never coverage. */
  glow: boolean;
  /** One word for the first failing check ("read first", "Codex", "not in AGENTS.md", "datalad", "not eligible", "exception"). */
  word: string | null;
}

export interface DragPreview {
  /** What release would do. */
  verb: 'play' | 'add' | 'skip' | 'accept' | 'widen' | 'narrow' | 'fuse' | 'settle' | 'cut' | 'swap' | 'answer' | 'none';
  heads: HeadGlow[];
  /** Per-lane ghost on the straps, from rendering both lanes before and after. */
  ghost: { claude: GhostDelta; codex: GhostDelta };
  /** The exact line at reading size before a release that accepts mappings (§0a.5). */
  line: { text: string; scope: string; exceptions: string[]; files: FileName[] } | null;
  /** Case ids whose mapping this release would accept. */
  accepts: string[];
  /** Why release would be refused; the pick is not spent. */
  refused: string | null;
}

export interface DragIntent {
  cardId: string;
  target: DragTarget | null;
  preview: DragPreview | null;
}

// ------------------------------------------------------------------ results

export interface PlayResultView {
  /** The play happened (false when refused, or for a skip). */
  played: boolean;
  skipped: boolean;
  refused: string | null;
  cardId: string | null;
  /** Heads whose true eight-check cover() is now true, in date order (the bind cascade animates exactly these). */
  bound: string[];
  /** Confirmed heads left standing: each tears one page onto the Open pile. */
  standing: string[];
  /** Case ids whose mapping the play accepted. */
  accepted: string[];
  /** The line that inks into each file. */
  ink: { file: FileName; line: string }[];
  /** True once the room's stamps are final. */
  finalized: boolean;
}

// ------------------------------------------------------------------ campfire (campfire worker)

export type LaneTab = 'claude' | 'both' | 'codex';

export interface ThreadView {
  id: string;
  color: 'gold' | 'red';
  members: string[];
  /** Gold: the fuse kind's factual reason. Red: plain words for the opposed claims. */
  reason: string;
  /** Gold only: the automatic text when the structured claims match, else null (the player writes it). */
  autoText: string | null;
}

export interface ChangePreviewView {
  before: { id: string; text: string }[];
  after: { text: string; targets: Targets; scope: string; exceptions: string[] } | null;
  /** The resulting exported lines of a settlement, per card (text null = removed). */
  lines: { id: string; text: string | null; files: FileName[] }[];
  ghost: { claude: GhostDelta; codex: GhostDelta };
  /** "Affected cases: 0 · deck total: 3 → 3" (§0a.9). */
  cases: { affected: number; deckBefore: number; deckAfter: number; opened: string[]; addressed: string[]; text: string };
  /** Cases a new text must be accepted for before it counts (check 8). */
  needsAcceptance: string[];
}

/** A settlement the player picks for a red thread (mirrors the engine's resolution; the adapter maps it). */
export type SettleChoice =
  | { kind: 'keep'; keep: string }
  | { kind: 'separate'; bind: string; projectKey: string; projectLabel: string }
  | { kind: 'exception'; on: string; text: string; when: { commandPrefix?: string; projectKey?: string; pathPrefix?: string } }
  | { kind: 'cancel' };

export interface CampfireView {
  tab: LaneTab;
  /** Projects a "separate the conditions" settlement can bind to. */
  projects: { key: string; label: string }[];
  lanes: Record<LaneTab, CardView[]>;
  focusedPair: { a: string; b: string; threadId: string | null } | null;
  threads: ThreadView[];
  books: BookView[];
  piles: PilesView;
  /** Cards cut at this fire, restorable until Apply. */
  ash: CardView[];
  /** One Open receipt the player pinned as a puzzle; eligibility shown, still not a drop target. */
  pinned: OpenPageView | null;
  /** "A file is over its allowance. Apply waits until it fits." when a clasp is open, else null. */
  coach: string | null;
  route: RouteView;
  status: StatusView;
}

// ------------------------------------------------------------------ the boss (boss/apply worker)

export interface BossHeadView {
  caseId: string;
  /** sealed = a withheld later case (stamped blind); open = an earlier Open page rising after the sealed heads. */
  source: 'sealed' | 'open';
  /** Readable before the stamp: blind means blind to the answer only (§0a.12). */
  receipt: ReceiptView;
  disposition: Disposition;
  addressed: boolean;
}

export interface BossCandidateView {
  cardId: string;
  glow: boolean;
  /** The first failing check among 2–7 in words, null when it glows. */
  reason: string | null;
}

export interface BossView {
  kind: 'boss' | 'audit';
  heads: BossHeadView[];
  /** The final deck's cards (the answer drag picks one) and the books they lie in. No new cards, no edits here. */
  cards: CardView[];
  books: BookView[];
  /** The head being revealed or answered, oldest first; null after the last. */
  current: string | null;
  /** For the current head once stamped a problem. */
  candidates: BossCandidateView[];
  noEligibleCard: boolean;
  score: {
    later: { addressed: number; confirmed: number };
    setAside: { notAProblem: number; changeOfPlan: number; unclear: number };
    unreviewed: number;
    earlier: { addressed: number; confirmed: number };
    original: { addressed: number; confirmed: number; unknown: number; established: boolean };
    /** The printed lines, set-asides always beside the score. */
    lines: string[];
    /** Locked after the last head, keyed to the final deck revision; stale when the deck changed since. */
    locked: boolean;
    stale: boolean;
  };
  canContinue: boolean;
}

// ------------------------------------------------------------------ Apply (boss/apply worker, presentation only)

export type InkState = 'pending' | 'inked' | 'failed';

export interface ApplyDiffView {
  label: string;
  path: string;
  /** Unified line ops; render with context. */
  ops: { op: 'same' | 'add' | 'del'; line: string }[];
  weight: { before: number; after: number; allowance: number } | null;
  problem: string | null;
  blocker: string | null;
  kind: 'global' | 'skill';
}

export interface ApplyBlockerView {
  kind: 'clasp' | 'conflict' | 'lane' | 'stale' | 'grant';
  text: string;
  /** Where "Return to the final campfire" should select. */
  select: { lane?: Agent; threadId?: string } | null;
}

export interface ApplyView {
  needs: { claude: boolean; codex: boolean; agents: boolean };
  diffs: ApplyDiffView[];
  notes: string[];
  blockers: ApplyBlockerView[];
  canSeal: boolean;
  stamps: { reviewed: InkState; fits: InkState; written: InkState };
  result: { status: 'written' | 'unchanged' | 'stale' | 'rejected' | 'backup-failed' | 'partial'; text: string; bundle: string | null } | null;
  undo: { status: 'done' | 'refused'; files: { path: string; text: string; conflict: boolean }[]; text: string | null } | null;
  footer: string;
}

// ------------------------------------------------------------------ layout bands (integrator: geometry.ts)

export interface Band {
  y: number;
  h: number;
}

/** The screen's bands for one viewport (§0a.17–19). A pure function of the viewport; see geometry.ts. */
export interface Bands {
  viewport: { w: number; h: number };
  mode: 'desktop' | 'tablet' | 'phone';
  header: Band;
  /** Spare sky above the creature. */
  sky: Band;
  /** The creature's box; its feet stand on shoreY. The cap is a ceiling, not a minimum. */
  creature: Band & { cap: number };
  wood: Band;
  status: Band;
  shoreY: number;
  /** M is the default and the minimum reading size at every width ≥ 600. */
  card: { size: 'S' | 'M' | 'L'; w: number; h: number };
  /** Rotate the fan only when the wood allows a rotated M (293 px); phones use a snapping carousel. */
  fan: 'rotated' | 'flat' | 'carousel';
  books: { mode: 'props' | 'tabs'; w: number; gap: number };
  cards: { gap: number };
  piles: { mode: 'props' | 'rail'; w: number; gap: number };
  /** Total of the gaps between the three wood groups, and of the two outer margins. */
  groupGap: number;
  margin: number;
  /** books + cards + piles + gaps + margins; always ≤ the viewport width. */
  rowWidth: number;
  /** The stage is too short for the clamps: lay out at the minimum heights and scroll; never shrink text. */
  scroll: boolean;
  /** Touch targets: at least 44 px, at least 8 px apart. */
  touch: { min: number; gap: number };
}

// ------------------------------------------------------------------ the controller's screen and callbacks

export type Screen =
  | { kind: 'room'; view: RoomView }
  | { kind: 'event'; view: RoomView }
  | { kind: 'campfire'; view: CampfireView }
  | { kind: 'boss'; view: BossView }
  | { kind: 'apply'; view: ApplyView }
  | { kind: 'empty'; text: string };

/** Presentation state the controller keeps beside the game state: selection, inspector, drag, motion. */
export interface UiView {
  /** Tap–tap: the card selected by the first tap, waiting for a target. */
  selected: string | null;
  inspect: { cardId: string } | { caseId: string } | null;
  drag: DragIntent | null;
  /** Room beat for choreography; every beat is interruptible and none waits on an animation. */
  beat: 'rise' | 'judge' | 'deal' | 'play' | 'strike' | 'clear' | null;
  reducedMotion: boolean;
  bands: Bands;
  /** Why the last drop or act was refused (the pick was not spent), until the next input. */
  notice: string | null;
  /**
   * What a campfire drop proposed. Stacking proposes; confirming performs (§7): the seal calls the matching api
   * (fuse, settle, swap, cut, retarget). Escape or pulling the top card off clears it.
   */
  pending:
    | { kind: 'stack'; a: string; b: string; threadId: string | null }
    | { kind: 'swap'; shelfId: string; deckId: string }
    | { kind: 'cut'; cardId: string }
    | { kind: 'retarget'; cardId: string; lane: Agent }
    | null;
}

/**
 * The callbacks the controller hands to components. Components call these and never hold game state. The controller
 * maps each to an adapter act; refused acts come back as the view's own fields (refused, offer, blockers).
 */
export interface ControllerApi {
  stamp(caseId: string, stamp: Stamp): void;
  focusReceipt(caseId: string): void;
  deal(): void;
  pullBack(): void;
  skip(): void;
  advance(): void;
  answerExisting(cardId: string, caseId: string, yes: boolean): void;
  wording(roomKey: string, text: string): void;
  /** Tap–tap: select a card (null clears), then tap a target. */
  select(cardId: string | null): void;
  tapTarget(target: DragTarget): void;
  /** Resolve a drop on a target: the controller picks the act (play, skip, accept, fuse, settle, cut, re-target, answer). */
  drop(cardId: string, target: DragTarget): void;
  /** The preview for a hover, or null. Never binds. */
  preview(cardId: string, target: DragTarget | null): DragPreview | null;
  inspect(ref: { cardId: string } | { caseId: string } | null): void;
  /** Clear a pending proposal, the selection and any notice (Escape). */
  cancel(): void;
  campfire: {
    tab(tab: LaneTab): void;
    focus(pair: { a: string; b: string; threadId: string | null } | null): void;
    pin(caseId: string | null): void;
    changePreview(q: { threadId: string; text?: string; settle?: SettleChoice } | { cutId: string }): ChangePreviewView | null;
    fuse(threadId: string, text: string): void;
    settle(threadId: string, choice: SettleChoice): void;
    cut(cardId: string): void;
    restore(cardId: string): void;
    sharpen(cardId: string, text: string): void;
    retarget(cardId: string, lane: Agent): void;
    swap(shelfId: string, deckId: string): void;
    acceptMapping(cardId: string, caseId: string): void;
    acceptImport(cardId: string): void;
    raiseAllowance(lane: Agent, to: number): void;
  };
  boss: {
    stamp(caseId: string, stamp: Stamp): void;
    answer(cardId: string, caseId: string): void;
    next(): void;
  };
  apply: {
    /** Ask for a folder (~/.claude, ~/.codex or ~/.agents); the deck is re-read under it and the diff rebuilt. */
    grant(which: 'claude' | 'codex' | 'agents'): Promise<void>;
    prepare(): Promise<void>;
    seal(): Promise<void>;
    undo(): Promise<void>;
    returnToCampfire(select: { lane?: Agent; threadId?: string } | null): void;
  };
}

/**
 * How components register drag sources and drop targets (implemented by drag.ts). The mount clears every
 * registration before each paint; components bind again as they render. Targets must be at least 44 × 44 px.
 */
export interface DropBinder {
  bindCard(cardId: string, el: HTMLElement): () => void;
  bindTarget(id: string, target: DragTarget, el: HTMLElement): () => void;
}

/** What every screen component receives from the mount. */
export interface ScreenProps<V> {
  view: V;
  ui: UiView;
  api: ControllerApi;
  drag: DropBinder;
}

// ------------------------------------------------------------------ pure selectors (copy only, no engine)

/** "3/3 confirmed addressed · 2 unreviewed"; never a bare 0/0 (§0a.6). */
export function pipsText(addressed: number, confirmed: number, unreviewed: number): string {
  const tail = unreviewed > 0 ? ` · ${unreviewed} unreviewed` : '';
  return confirmed === 0 ? `No confirmed problems${tail}` : `${addressed}/${confirmed} confirmed addressed${tail}`;
}

/** "n eligible here · m newly addressed" (§0a.3). */
export function footerText(eligible: number, newly: number): string {
  return `${eligible} eligible here · ${newly} newly addressed`;
}

/** "N more · a bound · u unreviewed" (§22). */
export function overflowText(more: number, bound: number, unreviewed: number): string {
  return `${more} more · ${bound} bound · ${unreviewed} unreviewed`;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/** "+46 line · +22 block header", "+46", "−15"; the caller prints COPY.estimated beside it. */
export function ghostText(g: Pick<GhostDelta, 'delta' | 'line' | 'blockHeader' | 'other'>): string {
  if (g.delta === 0 && g.line === 0) return 'no change';
  const parts: string[] = [];
  if (g.line !== 0) parts.push(`${signed(g.line)} line`);
  if (g.blockHeader !== 0) parts.push(`${signed(g.blockHeader)} block header`);
  if (g.other !== 0) parts.push(`${signed(g.other)} other`);
  return parts.length > 1 ? parts.join(' · ') : signed(g.delta);
}

/** "Affected cases: 0 · deck total: 3 → 3" (§0a.9). */
export function casesText(affected: number, before: number, after: number): string {
  return `Affected cases: ${affected} · deck total: ${before} → ${after}`;
}

/**
 * One word for a head's first failing check while dragging (§2 step 4). `lane` is set for a book drop, so the other
 * agent's heads read "not in AGENTS.md" rather than the agent's name.
 */
export function failWord(check: Check, tri: Tri, head: { agent: Agent; project: string | null }, lane?: Agent): string {
  switch (check) {
    case 'confirmed_issue':
      return tri === 'unknown' ? 'read first' : 'set aside';
    case 'in_export':
      return `not in ${FILE_OF[head.agent]}`;
    case 'targets_agent':
      return lane ? `not in ${FILE_OF[head.agent]}` : AGENT_NAME[head.agent];
    case 'scope_matches':
      return tri === 'unknown' ? 'project unknown' : head.project ?? 'other project';
    case 'trigger_true':
      return tri === 'unknown' ? 'not mapped' : 'not this case';
    case 'response_eligible':
      return 'not eligible';
    case 'exceptions_clear':
      return tri === 'unknown' ? 'exception unread' : 'exception';
    case 'mapping_accepted':
      return 'not accepted';
  }
}

/** A boss candidate's reason in words: "Codex · not in AGENTS.md", "datalad · scoped elsewhere". */
export function bossReason(check: Check, tri: Tri, head: { agent: Agent; project: string | null }): string {
  switch (check) {
    case 'in_export':
    case 'targets_agent':
      return `${AGENT_NAME[head.agent]} · not in ${FILE_OF[head.agent]}`;
    case 'scope_matches':
      return `${head.project ?? 'this case'} · scoped elsewhere`;
    case 'trigger_true':
      return tri === 'unknown' ? 'not mapped to this kind of case' : 'does not apply to this case';
    case 'response_eligible':
      return 'not an eligible response here';
    case 'exceptions_clear':
      return tri === 'unknown' ? 'exceptions not reviewed' : 'an exception excludes this case';
    default:
      return failWord(check, tri, head);
  }
}
