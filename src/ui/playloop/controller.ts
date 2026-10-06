// The play loop's controller: one PlayState, one UiState, the room state machine and the input map (play-loop §2, §3,
// §0a.13–16). Rooms move Rise → Judge → Deal → Play → Strike → Clear; other nodes are Campfire, Event, Boss and Apply.
// Every act goes through the adapter. No beat waits on an animation: beats only tell the renderers what to animate,
// and any input moves on. The keyboard map is a pure function so it can be tested without a DOM.

import type { Agent } from '../../model';
import * as A from './adapter';
import type * as C from './contract';
import { layout, type Viewport } from './geometry';

export type Beat = C.UiView['beat'];

export interface UiState {
  selected: string | null;
  inspect: C.UiView['inspect'];
  drag: C.DragIntent | null;
  beat: Beat;
  reducedMotion: boolean;
  viewport: Viewport;
  notice: string | null;
  pending: C.UiView['pending'];
  /** Keyboard focus among heads (Tab) and cards (arrows). */
  headIndex: number;
  cardIndex: number;
}

// ------------------------------------------------------------------ the keyboard map (§3), pure

export type KeyIntent =
  | { kind: 'cancel' }
  | { kind: 'stamp'; stamp: C.Stamp }
  | { kind: 'walk-heads'; delta: 1 | -1 }
  | { kind: 'pick'; delta: 1 | -1 }
  | { kind: 'drop'; target: C.DragTarget }
  | { kind: 'inspect' }
  | { kind: 'deal' }
  | { kind: 'pull-back' }
  | { kind: 'advance' }
  | { kind: 'boss-next' }
  | { kind: 'seal' };

const STAMP_KEYS: Record<string, C.Stamp> = { a: 'issue', c: 'pivot', n: 'not-a-problem', u: 'unclear' };

/**
 * Keys (§3 with the 0a fourth stamp): arrows pick a card, Enter plays on the beast, 1 plays into CLAUDE.md, 2 into
 * AGENTS.md, S shelves, F flips and Space opens the inspector, Tab walks the heads, A / C / N / U stamp, Backspace
 * pulls the hand back, Escape cancels. Enter also deals when judging and moves on when a room is done.
 */
export function keyIntent(key: string, shift: boolean, screen: C.Screen): KeyIntent | null {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === 'Escape') return { kind: 'cancel' };
  if (screen.kind === 'room' || screen.kind === 'event') {
    const v = screen.view;
    if (v.phase === 'judge') {
      if (STAMP_KEYS[k]) return { kind: 'stamp', stamp: STAMP_KEYS[k]! };
      if (k === 'Tab') return { kind: 'walk-heads', delta: shift ? -1 : 1 };
      if (k === 'Enter') return v.canDeal ? { kind: 'deal' } : v.offer || v.kind === 'event' ? { kind: 'advance' } : null;
      return null;
    }
    if (v.phase === 'dealt') {
      if (k === 'ArrowRight') return { kind: 'pick', delta: 1 };
      if (k === 'ArrowLeft') return { kind: 'pick', delta: -1 };
      if (k === 'Enter') return { kind: 'drop', target: { kind: 'beast' } };
      if (k === '1') return { kind: 'drop', target: { kind: 'book', lane: 'claude' } };
      if (k === '2') return { kind: 'drop', target: { kind: 'book', lane: 'codex' } };
      if (k === 's') return { kind: 'drop', target: { kind: 'shelf' } };
      if (k === 'f' || k === ' ') return { kind: 'inspect' };
      if (k === 'Tab') return { kind: 'walk-heads', delta: shift ? -1 : 1 };
      if (k === 'Backspace') return { kind: 'pull-back' };
      return null;
    }
    return k === 'Enter' ? { kind: 'advance' } : k === 'Tab' ? { kind: 'walk-heads', delta: shift ? -1 : 1 } : null;
  }
  if (screen.kind === 'boss') {
    if (STAMP_KEYS[k]) return { kind: 'stamp', stamp: STAMP_KEYS[k]! };
    if (k === 'ArrowRight') return { kind: 'pick', delta: 1 };
    if (k === 'ArrowLeft') return { kind: 'pick', delta: -1 };
    if (k === 'Enter') return screen.view.current ? { kind: 'boss-next' } : { kind: 'advance' };
    return null;
  }
  if (screen.kind === 'campfire') return k === 'Enter' ? { kind: 'advance' } : null;
  if (screen.kind === 'apply') return k === 'Enter' && screen.view.canSeal ? { kind: 'seal' } : null;
  return k === 'Enter' ? { kind: 'advance' } : null;
}

// ------------------------------------------------------------------ the controller

function beatFor(screen: C.Screen, prev: Beat): Beat {
  if (screen.kind !== 'room' && screen.kind !== 'event') return null;
  const v = screen.view;
  if (v.phase === 'done') return v.result && v.result.standing.length > 0 && prev !== 'clear' ? 'strike' : 'clear';
  if (v.phase === 'dealt') return prev === 'play' ? 'play' : 'deal';
  return prev === null || prev === 'clear' ? 'rise' : 'judge';
}

export class Controller {
  state: A.PlayState;
  ui: UiState;
  private subs = new Set<() => void>();
  private cached: { state: A.PlayState; screen: C.Screen } | null = null;
  readonly api: C.ControllerApi;

  constructor(
    state: A.PlayState,
    private port: A.ApplyPort | null,
    opts: { viewport: Viewport; reducedMotion?: boolean },
  ) {
    this.state = state;
    this.ui = { selected: null, inspect: null, drag: null, beat: null, reducedMotion: !!opts.reducedMotion, viewport: opts.viewport, notice: null, pending: null, headIndex: 0, cardIndex: 0 };
    this.ui.beat = beatFor(this.screen(), null);
    this.api = this.buildApi();
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  screen(): C.Screen {
    if (this.cached?.state !== this.state) this.cached = { state: this.state, screen: A.selectScreen(this.state, this.port ?? undefined) };
    return this.cached.screen;
  }

  uiView(): C.UiView {
    return { selected: this.ui.selected, inspect: this.ui.inspect, drag: this.ui.drag, beat: this.ui.beat, reducedMotion: this.ui.reducedMotion, bands: layout(this.ui.viewport), notice: this.ui.notice, pending: this.ui.pending };
  }

  resize(viewport: Viewport): void {
    this.ui = { ...this.ui, viewport };
    this.emit();
  }

  /** Handle a key; returns true when it was used (the caller then prevents the default). */
  key(key: string, shift = false): boolean {
    const screen = this.screen();
    const intent = keyIntent(key, shift, screen);
    if (!intent) return false;
    const room = screen.kind === 'room' || screen.kind === 'event' ? screen.view : null;
    switch (intent.kind) {
      case 'cancel':
        this.api.cancel();
        break;
      case 'stamp': {
        if (screen.kind === 'boss') {
          if (screen.view.current) this.api.boss.stamp(screen.view.current, intent.stamp);
        } else if (room?.receipts.current) this.api.stamp(room.receipts.current.caseId, intent.stamp);
        break;
      }
      case 'walk-heads': {
        if (!room || room.heads.length === 0) return false;
        const i = (this.ui.headIndex + intent.delta + room.heads.length) % room.heads.length;
        this.ui = { ...this.ui, headIndex: i };
        this.api.focusReceipt(room.heads[i]!.caseId);
        break;
      }
      case 'pick': {
        const ids = room ? room.hand.map((c) => c.id) : screen.kind === 'boss' ? screen.view.candidates.filter((c) => c.glow).map((c) => c.cardId) : [];
        if (ids.length === 0) return false;
        const i = (this.ui.cardIndex + intent.delta + ids.length) % ids.length;
        this.ui = { ...this.ui, cardIndex: i, selected: ids[i]! };
        this.emit();
        break;
      }
      case 'drop': {
        const id = this.ui.selected ?? room?.hand[this.ui.cardIndex]?.id ?? room?.hand[0]?.id;
        if (!id) return false;
        this.api.drop(id, intent.target);
        break;
      }
      case 'inspect': {
        const id = this.ui.selected ?? room?.hand[this.ui.cardIndex]?.id;
        if (!id) return false;
        this.api.inspect({ cardId: id });
        break;
      }
      case 'deal':
        this.api.deal();
        break;
      case 'pull-back':
        this.api.pullBack();
        break;
      case 'advance':
        this.api.advance();
        break;
      case 'boss-next': {
        const b = screen.kind === 'boss' ? screen.view : null;
        if (b?.current && this.ui.selected && b.candidates.some((c) => c.cardId === this.ui.selected && c.glow)) this.api.boss.answer(this.ui.selected, b.current);
        else this.api.boss.next();
        break;
      }
      case 'seal':
        void this.api.apply.seal();
        break;
    }
    return true;
  }

  private emit(): void {
    for (const f of this.subs) f();
  }

  /** Apply a state transition, recompute the beat, clear transient input state, notify. */
  private commit(next: A.PlayState, patch: Partial<UiState> = {}): void {
    const nodeChanged = next.node !== this.state.node || next.sub !== this.state.sub;
    this.state = next;
    const prevBeat = nodeChanged ? null : (patch.beat ?? this.ui.beat);
    this.ui = { ...this.ui, drag: null, notice: null, ...patch, ...(nodeChanged ? { selected: null, inspect: null, pending: null, headIndex: 0, cardIndex: 0 } : {}) };
    this.ui.beat = patch.beat !== undefined && !nodeChanged ? patch.beat : beatFor(this.screen(), prevBeat);
    this.emit();
    // Arriving at Apply builds the diff at once (it reads the files through the port).
    if (nodeChanged && A.currentNode(next)?.kind === 'apply' && this.port) void this.api.apply.prepare();
  }

  private notice(text: string): void {
    this.ui = { ...this.ui, notice: text, drag: null };
    this.emit();
  }

  /** What a drop on a target does, by screen. Campfire drops only propose; the seal performs. */
  private drop(cardId: string, target: C.DragTarget): void {
    const screen = this.screen();
    if (screen.kind === 'room' || screen.kind === 'event') {
      if (target.kind === 'shelf') return this.commit(A.actSkip(this.state).state, { selected: null });
      if (target.kind === 'beast' || target.kind === 'book') {
        const { state, result } = A.actPlay(this.state, cardId, target.kind === 'beast' ? 'beast' : target.lane);
        if (result.refused) return this.notice(result.refused);
        return this.commit(state, { selected: null, beat: result.standing.length ? 'strike' : 'clear' });
      }
      if (target.kind === 'head') return this.commit(A.actAcceptOnHead(this.state, cardId, target.caseId));
      return;
    }
    if (screen.kind === 'campfire') {
      const v = screen.view;
      if (target.kind === 'card') {
        const onShelf = v.piles.shelf.some((c) => c.id === cardId);
        if (onShelf) return this.commit(this.state, { pending: { kind: 'swap', shelfId: cardId, deckId: target.cardId } });
        const t = v.threads.find((x) => x.members.includes(cardId) && x.members.includes(target.cardId)) ?? null;
        const focus = { a: cardId, b: target.cardId, threadId: t?.id ?? null };
        return this.commit(A.actFocusPair(this.state, focus), { pending: { kind: 'stack', ...focus } });
      }
      if (target.kind === 'fire') return this.commit(this.state, { pending: { kind: 'cut', cardId } });
      if (target.kind === 'book-retarget' || target.kind === 'book') return this.commit(this.state, { pending: { kind: 'retarget', cardId, lane: target.lane } });
      return;
    }
    if (screen.kind === 'boss' && target.kind === 'head') {
      const next = A.actBossAnswer(this.state, cardId, target.caseId);
      if (next === this.state) return this.notice(screen.view.candidates.find((c) => c.cardId === cardId)?.reason ?? C_NO_ELIGIBLE);
      return this.commit(next);
    }
  }

  private buildApi(): C.ControllerApi {
    const run = (f: (s: A.PlayState) => A.PlayState) => () => this.commit(f(this.state));
    const port = () => this.port;
    return {
      stamp: (caseId, stamp) => this.commit(A.actStamp(this.state, caseId, stamp), { beat: 'judge' }),
      focusReceipt: (caseId) => this.commit(A.actFocusReceipt(this.state, caseId)),
      deal: () => this.commit(A.actDeal(this.state), { beat: 'deal' }),
      pullBack: () => this.commit(A.actPullBack(this.state), { beat: 'judge', selected: null }),
      skip: () => this.commit(A.actSkip(this.state).state, { selected: null }),
      advance: run(A.actAdvance),
      answerExisting: (cardId, caseId, yes) => this.commit(A.actAnswerExisting(this.state, cardId, caseId, yes)),
      wording: (roomKey, text) => this.commit(A.actWording(this.state, roomKey, text)),
      select: (cardId) => {
        this.ui = { ...this.ui, selected: cardId, notice: null };
        this.emit();
      },
      tapTarget: (target) => {
        const id = this.ui.selected;
        if (id) this.drop(id, target);
      },
      drop: (cardId, target) => this.drop(cardId, target),
      preview: (cardId, target) => {
        const p = target ? A.selectDrag(this.state, cardId, target) : null;
        this.ui = { ...this.ui, drag: { cardId, target, preview: p }, beat: this.ui.beat === 'deal' ? 'play' : this.ui.beat };
        this.emit();
        return p;
      },
      inspect: (ref) => {
        this.ui = { ...this.ui, inspect: ref };
        this.emit();
      },
      cancel: () => {
        this.ui = { ...this.ui, selected: null, drag: null, pending: null, notice: null, inspect: null, beat: this.ui.beat === 'play' ? 'deal' : this.ui.beat };
        this.emit();
      },
      campfire: {
        tab: (tab) => this.commit(A.actTab(this.state, tab)),
        focus: (pair) => this.commit(A.actFocusPair(this.state, pair)),
        pin: (caseId) => this.commit(A.actPin(this.state, caseId)),
        changePreview: (q) => ('cutId' in q ? A.selectChangePreview(this.state, q) : A.selectChangePreview(this.state, { threadId: q.threadId, ...(q.text !== undefined ? { text: q.text } : {}), ...(q.settle ? { resolution: q.settle } : {}) })),
        fuse: (threadId, text) => this.commit(A.actFuse(this.state, threadId, text), { pending: null }),
        settle: (threadId, choice) => this.commit(A.actSettle(this.state, threadId, choice), { pending: null }),
        cut: (cardId) => this.commit(A.actCut(this.state, cardId), { pending: null }),
        restore: (cardId) => this.commit(A.actRestore(this.state, cardId)),
        sharpen: (cardId, text) => this.commit(A.actSharpen(this.state, cardId, text)),
        retarget: (cardId, lane: Agent) => this.commit(A.actRetarget(this.state, cardId, lane), { pending: null }),
        swap: (shelfId, deckId) => this.commit(A.actSwap(this.state, shelfId, deckId), { pending: null }),
        acceptMapping: (cardId, caseId) => this.commit(A.actAcceptMapping(this.state, cardId, caseId)),
        acceptImport: (cardId) => this.commit(A.actAcceptImport(this.state, cardId)),
        raiseAllowance: (lane, to) => this.commit(A.actRaiseAllowance(this.state, lane, to)),
      },
      boss: {
        stamp: (caseId, stamp) => this.commit(A.actBossStamp(this.state, caseId, stamp)),
        answer: (cardId, caseId) => this.drop(cardId, { kind: 'head', caseId }),
        next: run(A.actBossNext),
      },
      apply: {
        grant: async (which) => {
          const p = port();
          if (p) this.commit(await A.actGrant(this.state, p, which));
        },
        prepare: async () => {
          const p = port();
          if (p) this.commit(await A.actPrepareApply(this.state, p));
        },
        seal: async () => {
          const p = port();
          if (p) this.commit(await A.actSeal(this.state, p));
        },
        undo: async () => {
          const p = port();
          if (p) this.commit(await A.actUndo(this.state, p));
        },
        returnToCampfire: (select) => this.commit(A.actReturnToCampfire(this.state, select)),
      },
    };
  }
}

const C_NO_ELIGIBLE = 'No eligible card';
