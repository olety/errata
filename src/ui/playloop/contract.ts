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

/**
 * ≤ 20-character title, ≤ 64 visible-character summary (inline `code` spans arrive as backticks). An excerpt always
 * carries COPY.excerpt. Rendering rule: if a face still does not fit after measuring with the real font, render a
 * clamped excerpt of inspector.exact with COPY.excerpt; never clamp a summary silently, never shrink the reading size.
 */
export type CardFaceView = { title: string; summary: string } & ({ mode: 'exact' | 'summary'; mark: null } | { mode: 'excerpt'; mark: string });

/** A line at reading size before anything accepts a mapping (§0a.5): text, scope, exceptions, destination files. */
export interface ReadingView {
  text: string;
  scope: string;
  exceptions: string[];
  files: FileName[];
}

export interface CardInspectorView {
  /** The exact line as it will land in the file. */
  exact: string;
  targets: Targets;
  scope: string;
  trigger: string | null;
  exceptions: string[];
  /** "tokens, estimated: 138 bytes ÷ 3 = 46" */
  weightMath: string;
  quote: string | null;
  evidence: { agent: Agent; date: string | null; sessionLabel: string }[];
  /** Imported or edited lines whose mapping the player must accept from the inspector. */
  needsAcceptance: boolean;
  /**
   * An imported line with a suggested mapping: the player's judgment for its text as it is now (the inspector row
   * "Accept this reading" / "Does not apply", P4 item 3). Null for every other card.
   */
  importJudgment: 'accepted' | 'declined' | 'open' | null;
  /** Skills: the first lines of the SKILL.md body and its estimate, outside the allowance. */
  skill: { firstLines: string[]; estimate: number } | null;
  /** Not dealt: why (per-case ineligibility reasons). */
  unavailable: string[];
}

/**
 * Which painted plate fills a card's art window, by family (decoration only; it encodes nothing): wyrm = a repeated
 * directive, retry = a repeated unsuccessful command, scope = a boundary intervention, moth = a confirmed rewrite,
 * verify = a verified workflow or Skill, imported = a line read from your file (an inked book, no creature). Null: no
 * art (sealed protected text keeps its wax lock).
 */
export type CardArt = 'wyrm' | 'retry' | 'scope' | 'moth' | 'verify' | 'imported';

export interface CardView {
  id: string;
  /** protected = sealed protected text (a wax lock): it counts toward the budget, and it can be neither stacked nor cut. */
  type: 'rule' | 'skill' | 'protected' | 'trait';
  /** Sealed protected text (the Notes block): kept byte-for-byte, never a stack, fire or settle target. */
  sealed: boolean;
  /** The art plate for the art window, from the card's family; null for protected text and traits. */
  art: CardArt | null;
  face: CardFaceView;
  /** The weight orb: the card's own line weight, estimated tokens. */
  weight: number;
  targets: Targets;
  sigils: { claude: boolean; codex: boolean };
  /** "global" or the project chip. */
  scope: string;
  exceptions: string[];
  /** "seen once", "seen in 3 sessions", "seen passing in 2 sessions", "From your file" (provenanceText). Never adds power. */
  provenance: string;
  /** Rooms only: "answers n cases here" (footerText), counted against the card's displayed targets. */
  footer: { eligible: number; newly: number; text: string } | null;
  /**
   * Hand cards only, when a play on the beast would add the managed block header to a file (P4 item 2): "+46 tok ·
   * +22 once" (costText) and, per file that gains the header, the line's and the header's tokens, and the exact marker
   * lines the play adds (the begin and end comments, a section heading). Null otherwise.
   */
  cost: { text: string; files: { file: FileName; line: number; header: number }[]; markers: string[] } | null;
  /** The files that carry this card in the proposal now (empty for a draft). */
  inFiles: Agent[];
  inspector: CardInspectorView;
  /**
   * Hand cards only: what a play on the beast would do (glowing heads, per-lane ghost, the reading). Selecting one draft
   * then another compares these two previews, computed on the same proposal; null elsewhere.
   */
  playPreview: DragPreview | null;
}

export interface GhostDelta {
  before: number;
  after: number;
  delta: number;
  line: number;
  blockHeader: number;
  other: number;
  /** "+46 tok (+22 header, once)", "−15 tok", or "no change" (ghostText); always with COPY.estimated beside it. */
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
  /**
   * The explicit allowance raise (§5): the values the buckle offers, each above the current allowance. The player picks
   * one and confirms; the end screen then prints "allowance raised to N by you". Empty when no raise is offered.
   */
  raiseSteps: number[];
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
  shelfCount: number;
  /** A set keyed by case id: confirmed cases with no coverage in the current proposal (§0a.7). Never a drop target. */
  open: OpenPageView[];
  openCount: number;
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
  /** The knot's in-room cases (never a withheld one): clicking the knot opens their receipts in the inspector. */
  caseIds: string[];
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
  /** Every selected head in the room: heads[0] is the anchor (it leans in first), then by date. */
  heads: HeadView[];
  /**
   * The room's scope chip (check 4): "all projects" or one project. A room whose heads span several projects lets the
   * player confirm one while judging (api.confirmProject); the drafts then carry that project's scope, so heads from
   * other projects fail check 4 and say so.
   */
  scope: {
    chip: string;
    confirmed: { key: string; label: string } | null;
    projects: { key: string; label: string }[];
    confirmable: boolean;
    /**
     * When the human's words give a local reason ("on this box", "here") and the line is still global: "Your words
     * sound local ("on this box"); the line is global. Change the scope chip to keep it to one project." (P3 fix 15).
     */
    hint: string | null;
  };
  /** Boundary and directive rooms: the line in the player's words, editable while judging (api.wording). */
  wording: { value: string; editable: boolean } | null;
  /** One complete receipt at a time, with a visible queue (§0a.13). position is 1-based, 0 when none is current. */
  receipts: { current: ReceiptView | null; queue: string[]; progress: { position: number; total: number } };
  /**
   * Every head needs a stamp before the room can finalize ("Unclear · leave wrapped" is a stamp). remaining = heads
   * still unstamped. Deal, skip and every Continue wait for canFinalize, so no case is stranded unreviewed.
   */
  review: { remaining: number; canFinalize: boolean };
  phase: RoomPhase;
  /** Dealt drafts with observed eligibility only (§0a.4). Empty before dealing. */
  hand: CardView[];
  /** Drafts not dealt, with their reasons, for the inspector. */
  unavailable: CardView[];
  books: BookView[];
  /** The cards already in the proposal (BookView.cardIds index into these): drag one onto a standing head to accept it. */
  deck: CardView[];
  piles: PilesView;
  route: RouteView;
  status: StatusView;
  /** COPY.finalizes while dealt; the UI says which action finalizes. */
  finalizes: string | null;
  canDeal: boolean;
  /** Skip (or a drop on the shelf) is allowed: the hand is dealt, or every head is stamped. */
  canSkip: boolean;
  /** Offer Continue at once when every judged head is set aside, or Keep existing when imported lines cover all (§0a.14). */
  offer: 'continue-all-set-aside' | 'keep-existing' | null;
  /** An already-imported line that passes checks 3–7 for a bared head asks "Already in your file. Does it answer this case?" */
  existingAsks: { cardId: string; caseId: string; reading: ReadingView }[];
  /** The room's result after its play or skip. */
  result: PlayResultView | null;
  /**
   * After the play or skip: "3 cases now have a proposed line. Nothing is prevented; lines land only when you Apply."
   * (clearText over the room's answered and open heads); null before.
   */
  clear: string | null;
  /**
   * A dealt hand of two or more: one line naming how the drafts differ, from their response keys (what the agent does
   * next); null otherwise (P3 gate fix H).
   */
  handDiffers: string | null;
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
  /** The head's tag, so a comparison can name heads (agent, project, date) instead of numbering them. */
  tag: { agent: Agent; project: string | null; date: string | null };
  /** Checks 1 and 3–7 hold against the prospective export for this target: conditional eligibility, never coverage. */
  glow: boolean;
  /** One word for the first failing check ("read first", "Codex", "not in AGENTS.md", "datalad", "not eligible", "exception"). */
  word: string | null;
}

export interface DragPreview {
  /** What release would do. */
  verb: 'play' | 'add' | 'skip' | 'accept' | 'widen' | 'narrow' | 'fuse' | 'settle' | 'cut' | 'swap' | 'answer' | 'forge' | 'none';
  heads: HeadGlow[];
  /** Per-lane ghost on the straps, from rendering both lanes before and after. */
  ghost: { claude: GhostDelta; codex: GhostDelta };
  /** The exact line at reading size before a release that accepts mappings (§0a.5). Never null when accepts is non-empty. */
  line: ReadingView | null;
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
  /** Monotonic per run: a repaint of the same result never replays its animation. */
  id: number;
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
  /**
   * Gold only, when a member pair's content words overlap: the shared words and the share, for the preview (never on the
   * thread itself, P3 gate fix 12). Null otherwise.
   */
  shared: { words: string[]; of: number } | null;
  /** Red only: the member played most recently (a card from this act over a line read from your file); Keep one starts on it. */
  newer: string | null;
}

/**
 * A campfire change before its seal. Quantities are over the run's reviewed cases (every stamped case, withheld ones
 * only once stamped at the boss): deckBefore / deckAfter = cases addressed, opened = addressed before and not after,
 * addressed = the reverse, affected = opened + addressed. A new text counts nothing until accepted (needsAcceptance).
 */
export interface ChangePreviewView {
  before: { id: string; text: string }[];
  after: { text: string; targets: Targets; scope: string; trigger: string | null; exceptions: string[] } | null;
  /** The card the change leaves in the deck (the fused or rewritten card), for accepting its mappings after the seal. */
  resultId: string | null;
  /** Why the seal would be refused, or null. */
  refused: string | null;
  /** The resulting exported lines of a settlement, per card (text null = removed). */
  lines: { id: string; text: string | null; files: FileName[] }[];
  ghost: { claude: GhostDelta; codex: GhostDelta };
  /** "Affected cases: 0 · deck total: 3 → 3" (§0a.9). */
  cases: { affected: number; deckBefore: number; deckAfter: number; opened: string[]; addressed: string[]; text: string };
  /** Cases a new text must be accepted for before it counts (check 8). */
  needsAcceptance: string[];
  /** Every case id named above (opened, addressed, needsAcceptance), with its tag, so a preview can name each case. */
  refs: { caseId: string; agent: Agent; project: string | null; date: string | null }[];
  /** The files whose bytes the seal would change (P3 gate fix 10): a preview names only these. */
  changed: FileName[];
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
  ashCount: number;
  /** One Open receipt the player pinned as a puzzle; eligibility shown, still not a drop target. */
  pinned: OpenPageView | null;
  /** Checks 2–7 of every deck card against the pinned case: conditional eligibility, never coverage. Empty when none. */
  pinnedCandidates: BossCandidateView[];
  /** "A file is over budget. Apply waits until it fits." when a clasp is open, else null. */
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
  /** The run's largest family skin, grown huge (§4, §9). Decoration only. */
  skin: Skin;
  /**
   * stamp = the current sealed head is readable and waits for its blind stamp (no candidate, no answer hint) ·
   * answer = stamped a problem (or an Open page): candidates glow, or "No eligible card" · set-aside = stamped
   * otherwise · summary = every head has faced the final deck. boss.next() moves the turn; advance() leaves the node.
   */
  turn: 'stamp' | 'answer' | 'set-aside' | 'summary';
  /** Revealed heads only, in order: the current one and those before it. Later sealed heads stay a count. */
  heads: BossHeadView[];
  /** Sealed heads not yet revealed: a count, never words. */
  remaining: number;
  route: RouteView;
  status: StatusView;
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
    /** The lines from your files not yet judged, each as printed in `lines` ('Report what you changed…'), to link (P4 item 3). */
    unjudged: UnjudgedLineView[];
    /** live = still being answered · locked = keyed to the final deck revision · stale = the deck changed since: lock again. */
    validity: 'live' | 'locked' | 'stale';
  };
  canContinue: boolean;
}

// ------------------------------------------------------------------ Apply (boss/apply worker, presentation only)

/** undone = it inked, then Undo restored the original bytes (the stamp shows cracked, never still inked). */
export type InkState = 'pending' | 'inked' | 'failed' | 'undone';

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

/** The end screen's accounting (§7, §9, §0a.11), computed by the adapter. */
/** A line from your files whose suggested mapping is not yet judged: its card and the excerpt the tally prints. */
export interface UnjudgedLineView {
  cardId: string;
  excerpt: string;
}

export interface RunSummaryView {
  /** The boss's printed lines: later cases with set-asides, earlier confirmed cases, the original files. */
  lines: string[];
  /** As BossView.score.unjudged: each excerpt in `lines` links to its inspector row. */
  unjudged: UnjudgedLineView[];
  open: OpenPageView[];
  openCount: number;
  /** Every set-aside disposition in the run, by date. */
  setAside: { receipt: ReceiptView; disposition: 'pivot' | 'not-a-problem' | 'unclear' }[];
  /** The shelf: drafted and never written. */
  notWritten: CardView[];
  /** Successful committed operations, by kind. */
  operations: { kind: 'add' | 'fuse' | 'settle' | 'cut' | 'restore' | 'sharpen' | 'retarget' | 'swap'; count: number }[];
  files: { lane: Agent; file: FileName; before: number; after: number; allowance: number; raisedBy: number | null }[];
}

export interface ApplyView {
  route: RouteView;
  status: StatusView;
  /** An async act in flight; the controller refuses overlapping grants, seals and undos. */
  busy: 'idle' | 'granting' | 'preparing' | 'sealing' | 'undoing';
  needs: { claude: boolean; codex: boolean; agents: boolean };
  books: BookView[];
  summary: RunSummaryView;
  diffs: ApplyDiffView[];
  notes: string[];
  blockers: ApplyBlockerView[];
  canSeal: boolean;
  stamps: { reviewed: InkState; fits: InkState; written: InkState };
  result: { status: 'written' | 'unchanged' | 'stale' | 'rejected' | 'backup-failed' | 'partial'; text: string; bundle: string | null; files: { path: string; status: 'written-verified' | 'unchanged' | 'failed' | 'not-attempted' }[] } | null;
  canUndo: boolean;
  undo: { status: 'done' | 'refused'; files: { path: string; text: string; conflict: boolean }[]; text: string | null } | null;
  /** COPY.footer only after a verified write (or a verified no-change); null before and after any failure. */
  footer: string | null;
  /**
   * A browser without folder access (P3): nothing can be written, so Apply shows each file's managed block to paste,
   * with a download, under "Exported, not applied". Null when the folders can be written.
   */
  exported: { file: FileName; path: string; text: string; download: string }[] | null;
  /**
   * After a verified write: keep the receipt (bundle id, files, checksums) and the stable line ids in this browser, only
   * when the player says so (spec §7, second visit). offered = a written receipt exists; saved = it is kept now.
   */
  remember: { offered: boolean; saved: boolean };
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
  /**
   * Below 500 px wide the Table is a page that scrolls (P3 gate fix F): the bands stack in the flow at their content's
   * height, nothing is fixed, and the room's controls stick to the bottom of the screen.
   */
  flow: boolean;
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

/** One per-case mapping row in the inspector: accept from here when it is eligible and not yet accepted. */
export interface MappingReviewView {
  cardId: string;
  caseId: string;
  receipt: ReceiptView;
  /** Checks 1 and 3–7 hold for the card as it stands. */
  eligible: boolean;
  /** cover() is true now (the mapping is accepted for this exact text). */
  accepted: boolean;
  reason: string | null;
}

/** The one inspector, resolved by the adapter (§0a.15). Withheld cases never appear here before the boss reveals them. */
export type InspectorView =
  | { kind: 'card'; card: CardView; reading: ReadingView; evidence: { sessionLabel: string; receipt: ReceiptView | null }[]; mappings: MappingReviewView[] }
  | { kind: 'case'; receipt: ReceiptView; queue: ReceiptView[] };

/** A committed change, for exactly-once animation. bound / unbound = cases whose cover() flipped, in cascade order. */
export interface CommitEffectView {
  id: number;
  kind: 'stamp' | 'play' | 'skip' | 'accept' | 'forge' | 'fuse' | 'settle' | 'cut' | 'restore' | 'sharpen' | 'retarget' | 'swap' | 'boss-answer' | 'other';
  bound: string[];
  unbound: string[];
}

/** Presentation state the controller keeps beside the game state: selection, inspector, drag, motion. */
export interface UiView {
  /** Tap–tap: the card selected by the first tap, waiting for a target. */
  selected: string | null;
  inspect: { cardId: string } | { caseId: string } | null;
  /** The inspector's content for `inspect`, resolved by the adapter. */
  inspector: InspectorView | null;
  drag: DragIntent | null;
  /** The last committed change; animate it once per id. */
  effect: CommitEffectView | null;
  /** Coach line and spotlight on the tutorial route; null elsewhere (filled by the integrator in P1). */
  tutorial: { text: string; focus: { kind: 'card'; cardId: string } | { kind: 'thread'; threadId: string } | { kind: 'target'; target: DragTarget } | null } | null;
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
    /** A stack proposes the whole thread (a uv triple seals as one), never a pair without a thread. */
    | { kind: 'stack'; a: string; b: string; threadId: string; members: string[] }
    | { kind: 'swap'; shelfId: string; deckId: string }
    | { kind: 'cut'; cardId: string }
    | { kind: 'retarget'; cardId: string; targets: Targets }
    /** Tap–tap or a key aimed at a target whose reading was not on screen: it is now; the same act again confirms. */
    | { kind: 'confirm'; cardId: string; target: DragTarget }
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
  /** Confirm the room's line for one project (null: all projects again). Only while judging. */
  confirmProject(roomKey: string, projectKey: string | null): void;
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
    changePreview(
      q: { threadId: string; text?: string; settle?: SettleChoice } | { cutId: string } | { swap: { shelfId: string; deckId: string } } | { retarget: { cardId: string; targets: Targets } } | { sharpen: { cardId: string; text: string } },
    ): ChangePreviewView | null;
    fuse(threadId: string, text: string): void;
    settle(threadId: string, choice: SettleChoice): void;
    cut(cardId: string): void;
    restore(cardId: string): void;
    sharpen(cardId: string, text: string): void;
    retarget(cardId: string, targets: Targets): void;
    swap(shelfId: string, deckId: string): void;
    acceptMapping(cardId: string, caseId: string): void;
    acceptImport(cardId: string): void;
    /** Judge an imported line's suggested mapping "does not apply" (P4 item 3). */
    declineImport(cardId: string): void;
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
    /** Keep (true) or forget (false) the written receipt in this browser; only on the player's word. */
    remember(on: boolean): void;
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

/**
 * "0 of 3 cases answered by a proposed line · 0 unreviewed": the word cases is mandatory, the unreviewed count always
 * prints, never a bare 0/0 (§0a.6, P3 gate fix 3).
 */
export function pipsText(addressed: number, confirmed: number, unreviewed: number): string {
  const main = confirmed === 0 ? 'No cases confirmed as a problem' : `${addressed} of ${confirmed} ${confirmed === 1 ? 'case' : 'cases'} answered by a proposed line`;
  return `${main} · ${unreviewed} unreviewed`;
}

/**
 * A dealt card's footer: "answers 3 cases here" (P3 gate fix 7); never "addressed" on an unplayed card. How many of
 * those already have a line in the proposal (eligible − newly) is the inspector's line, not the face's.
 */
export function footerText(eligible: number, _newly: number): string {
  return `answers ${eligible} ${eligible === 1 ? 'case' : 'cases'} here`;
}

/** "N more · a bound · u unreviewed" (§22). */
export function overflowText(more: number, bound: number, unreviewed: number): string {
  return `${more} more · ${bound} bound · ${unreviewed} unreviewed`;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/** What the block header is, said once in the inspector beside its figure (P3 gate fix 9, P4 item 2). */
export const BLOCK_HEADER_WHY = 'the one-time marker lines';

/** The inspector's sentence on the header cost: why a first line costs more than the next (P4 item 2). */
export const BLOCK_HEADER_LONG =
  "The first of the game's lines in a file brings the managed block's marker lines: its begin and end comments and a section heading. The first Skill pointer brings its own heading. Each is paid once per file; later lines add only their own tokens.";

/**
 * The ghost while dragging (P4 item 1): "+46 tok (+22 header, once)", "+46 tok", "−15 tok", "+60 tok · −1 rounding".
 * The line's own tokens lead; the block header is named as paid once; a remainder is per-block rounding when it is a
 * token or two, else the other text that changed (P3 gate fix 13). Every figure is estimated; the caller says so.
 */
export function ghostText(g: Pick<GhostDelta, 'delta' | 'line' | 'blockHeader' | 'other'>): string {
  if (g.delta === 0 && g.line === 0 && g.blockHeader === 0 && g.other === 0) return 'no change';
  if (g.line === 0 && g.blockHeader === 0) return `${signed(g.delta)} tok`;
  const head = g.blockHeader !== 0 ? ` (${signed(g.blockHeader)} header, once)` : '';
  const other = g.other !== 0 ? ` · ${signed(g.other)} ${Math.abs(g.other) <= 2 ? 'rounding' : 'other text'}` : '';
  return `${signed(g.line)} tok${head}${other}`;
}

/**
 * A dealt card's cost when its play would add the managed block header to a file (P4 item 2): "+46 tok · +22 once",
 * or "+46 tok · +22–23 once" when the files' headers differ by rounding. Null when no file gains a header.
 */
export function costText(line: number, headers: readonly number[]): string | null {
  const h = headers.filter((x) => x > 0);
  if (!h.length) return null;
  const lo = Math.min(...h);
  const hi = Math.max(...h);
  return `+${line} tok · ${lo === hi ? `+${lo}` : `+${lo}–${hi}`} once`;
}

/** "cases answered by the whole deck: 3 → 3 (this change affects 0)" (§0a.9, P3 gate fix 11). */
export function casesText(affected: number, before: number, after: number): string {
  return `cases answered by the whole deck: ${before} → ${after} (this change affects ${affected})`;
}

/** The budget word on every label (P4 item 1): the strap, the clasp, the end screen and the Fits stamp. */
export const BUDGET = 'token budget';

/** "over budget by 30" when a file is over its budget, else null (the open clasp, the strap, the end screen). */
export function overBudgetText(now: number, allowance: number): string | null {
  return now > allowance ? `over budget by ${(now - allowance).toLocaleString('en-US')}` : null;
}

/**
 * The strap's two lines (P4 item 1): "token budget" and "104 of 1,200 used · 1,096 left", or
 * "1,230 of 1,200 used · over budget by 30". Never a bare fraction, never a word that reads as health.
 */
export function strapText(now: number, allowance: number): { title: string; used: string } {
  const f = (n: number) => n.toLocaleString('en-US');
  const left = overBudgetText(now, allowance) ?? `${f(allowance - now)} left`;
  return { title: BUDGET, used: `${f(now)} of ${f(allowance)} used · ${left}` };
}

/** The Fits stamp on the end screen (P4 item 1): "both files within budget", or "CLAUDE.md over budget by 30". */
export function fitsText(files: readonly { file: string; now: number; allowance: number }[]): string {
  const over = files.filter((f) => f.now > f.allowance);
  if (!over.length) return files.length === 1 ? `${files[0]!.file} within budget` : 'both files within budget';
  return over.map((f) => `${f.file} ${overBudgetText(f.now, f.allowance)}`).join(' · ');
}

/** The Fits stamp's inspector line (P4 item 1). */
export const FITS_WHY = 'within the budget you chose';

/** The provenance seal in words (P3 gate fix 6): "seen once", "seen in 3 sessions", "seen passing in 2 sessions". */
export function provenanceText(kind: 'imported' | 'workflow' | 'other', sessions: number): string {
  if (kind === 'imported') return 'From your file';
  if (kind === 'workflow' && sessions >= 2) return `seen passing in ${sessions} sessions`;
  return sessions >= 2 ? `seen in ${sessions} sessions` : 'seen once';
}

/** The route's held-back count in full words (P3 gate fix 5). */
export function sealedText(count: number): string {
  return `${count} later ${count === 1 ? 'case' : 'cases'} held for the boss`;
}

/** One line on what withholding is (the sealed chip's explanation). */
export const SEALED_WHY = 'The game held these later cases back from the start. At the boss you read and stamp each one blind, then answer it with your own deck.';

/** The room's clear line (P3 gate fix 4): what a play did, and that nothing lands before Apply. */
export function clearText(answered: number, open: number): string {
  const a = `${answered} ${answered === 1 ? 'case now has' : 'cases now have'} a proposed line.`;
  const o = open > 0 ? ` ${open} ${open === 1 ? 'case stays' : 'cases stay'} open.` : '';
  return `${a}${o} Nothing is prevented; lines land only when you Apply.`;
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
      return tri === 'unknown' ? 'project unknown · applicability not established' : `${head.project ?? 'this case'} · scoped elsewhere`;
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
