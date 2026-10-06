// The play loop's controller: one PlayState, one UiState, the room state machine and the input map (play-loop §2, §3,
// §0a.13–16). Rooms move Rise → Judge → Deal → Play → Strike → Clear; other nodes are Campfire, Event, Boss and Apply.
// Every act goes through the adapter. No beat waits on an animation: beats only tell the renderers what to animate,
// and any input moves on. The keyboard map is a pure function so it can be tested without a DOM.

import * as A from './adapter';
import type * as C from './contract';
import { layout, type Viewport } from './geometry';
import { tutorialFor } from './tutorial';

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
  effect: C.CommitEffectView | null;
  effectSeq: number;
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
export function keyIntent(key: string, shift: boolean, screen: C.Screen, pending: C.UiView['pending'] = null): KeyIntent | null {
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
  // At the campfire Enter has one owner at a time: with a proposal up, the campfire's seal takes it; otherwise it leaves.
  if (screen.kind === 'campfire') return k === 'Enter' && !pending ? { kind: 'advance' } : null;
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
    this.ui = { selected: null, inspect: null, drag: null, beat: null, reducedMotion: !!opts.reducedMotion, viewport: opts.viewport, notice: null, pending: null, headIndex: 0, cardIndex: 0, effect: null, effectSeq: 0 };
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
    return {
      selected: this.ui.selected,
      inspect: this.ui.inspect,
      inspector: A.selectInspector(this.state, this.ui.inspect),
      drag: this.ui.drag,
      effect: this.ui.effect,
      tutorial: tutorialFor(this.state, this.screen(), this.ui.pending),
      beat: this.ui.beat,
      reducedMotion: this.ui.reducedMotion,
      bands: layout(this.ui.viewport),
      notice: this.ui.notice,
      pending: this.ui.pending,
    };
  }

  resize(viewport: Viewport): void {
    this.ui = { ...this.ui, viewport };
    this.emit();
  }

  /** Handle a key; returns true when it was used (the caller then prevents the default). */
  key(key: string, shift = false): boolean {
    const screen = this.screen();
    const intent = keyIntent(key, shift, screen, this.ui.pending);
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
        this.ui = { ...this.ui, cardIndex: i };
        // Through select, so the drag preview (the reading on the beast) and the open page refresh with the selection.
        this.api.select(ids[i]!);
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
        // Enter answers with the selected glowing card; once the head is answered (or nothing is selected) it moves on.
        const answered = !!b?.heads.find((h) => h.caseId === b.current)?.addressed;
        if (b?.current && !answered && this.ui.selected && b.candidates.some((c) => c.cardId === this.ui.selected && c.glow)) this.api.boss.answer(this.ui.selected, b.current);
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

  /**
   * Apply a state transition, recompute the beat, clear transient input state, notify. A changed state records one
   * effect with a fresh id: the cases whose cover() flipped, so renderers animate each committed change once.
   */
  private commit(next: A.PlayState, patch: Partial<UiState> = {}, kind: C.CommitEffectView['kind'] = 'other'): void {
    const nodeChanged = next.node !== this.state.node || next.sub !== this.state.sub;
    if (next !== this.state) {
      const before = A.selectCovered(this.state);
      const after = A.selectCovered(next);
      const seq = this.ui.effectSeq + 1;
      patch = { ...patch, effectSeq: seq, effect: { id: seq, kind, bound: [...after].filter((x) => !before.has(x)), unbound: [...before].filter((x) => !after.has(x)) } };
    }
    this.state = this.followTutorial(next, nodeChanged ? null : (patch.pending !== undefined ? patch.pending : this.ui.pending));
    const prevBeat = nodeChanged ? null : (patch.beat ?? this.ui.beat);
    this.ui = { ...this.ui, drag: null, notice: null, ...patch, ...(nodeChanged ? { selected: null, inspect: null, pending: null, headIndex: 0, cardIndex: 0 } : {}) };
    this.ui.beat = patch.beat !== undefined && !nodeChanged ? patch.beat : beatFor(this.screen(), prevBeat);
    this.emit();
    // Arriving at Apply builds the diff at once (it reads the files through the port).
    if (nodeChanged && A.currentNode(next)?.kind === 'apply' && this.port) void this.api.apply.prepare();
  }

  /**
   * At the fire the stage shows the pair the tutorial points at, but only when the focus is empty or names a thread
   * that is gone (sealed or settled): a pair the player picked is never taken away.
   */
  private followTutorial(s: A.PlayState, pending: C.UiView['pending']): A.PlayState {
    if (!s.sample || pending || A.currentNode(s)?.kind !== 'campfire') return s;
    const screen = A.selectScreen(s);
    if (screen.kind !== 'campfire') return s;
    const f = tutorialFor(s, screen, null)?.focus;
    if (f?.kind !== 'thread') return s;
    const cur = s.campfire.focus;
    if (cur && cur.threadId && screen.view.threads.some((t) => t.id === cur.threadId)) return s;
    const t = screen.view.threads.find((x) => x.id === f.threadId);
    return t ? A.actFocusPair(s, { a: t.members[0]!, b: t.members[1]!, threadId: t.id }) : s;
  }

  private notice(text: string): void {
    this.ui = { ...this.ui, notice: text, drag: null };
    this.emit();
  }

  /** True when the reading for this card on this target is on screen now (a hover, a selection, or a staged confirm). */
  private shown(cardId: string, target: C.DragTarget): boolean {
    const d = this.ui.drag;
    if (!d || d.cardId !== cardId || !d.preview || !d.target) return false;
    // A hand card over any head is a play on the beast (§3): the beast's reading and a head's are the same reading.
    const screen = this.screen();
    const inHand = (screen.kind === 'room' || screen.kind === 'event') && screen.view.hand.some((c) => c.id === cardId);
    const norm = (t: C.DragTarget): C.DragTarget => (inHand && t.kind === 'head' ? { kind: 'beast' } : t);
    return JSON.stringify(norm(d.target)) === JSON.stringify(norm(target));
  }

  /** What a drop on a target does, by screen. Campfire drops only propose; the seal performs. */
  private drop(cardId: string, target: C.DragTarget): void {
    const screen = this.screen();
    if (screen.kind === 'room' || screen.kind === 'event') {
      if (target.kind === 'shelf') {
        const { state, result } = A.actSkip(this.state);
        if (result.refused) return this.notice(result.refused);
        return this.commit(state, { selected: null }, 'skip');
      }
      // A hand card on the beast's body or any head plays on the beast (§3); an in-deck card on a head accepts it.
      const inHand = screen.view.hand.some((c) => c.id === cardId);
      if (target.kind === 'beast' || target.kind === 'book' || (target.kind === 'head' && inHand)) {
        // §0a.5: a release that accepts mappings needs its reading on screen first. A pointer drag shows it on hover;
        // tap–tap and keys stage it here, and the same act again confirms.
        if (!this.shown(cardId, target)) {
          const preview = A.selectDrag(this.state, cardId, target);
          if (preview.accepts.length > 0 || preview.refused) {
            this.ui = { ...this.ui, drag: { cardId, target, preview }, pending: preview.refused ? null : { kind: 'confirm', cardId, target }, notice: preview.refused ?? 'The line is on the table. Do it again to play it.' };
            this.emit();
            return;
          }
        }
        const { state, result } = A.actPlay(this.state, cardId, target.kind === 'book' ? target.lane : 'beast');
        if (result.refused) return this.notice(result.refused);
        const forge = screen.view.kind === 'workshop';
        return this.commit(state, { selected: null, pending: null, beat: result.standing.length ? 'strike' : 'clear' }, forge ? 'forge' : 'play');
      }
      if (target.kind === 'head') {
        if (!this.shown(cardId, target)) {
          const preview = A.selectDrag(this.state, cardId, target);
          this.ui = { ...this.ui, drag: { cardId, target, preview }, pending: preview.accepts.length ? { kind: 'confirm', cardId, target } : null, notice: preview.accepts.length ? 'The line is on the table. Do it again to accept it for this case.' : (preview.heads[0]?.word ?? null) };
          this.emit();
          return;
        }
        return this.commit(A.actAcceptOnHead(this.state, cardId, target.caseId), { pending: null }, 'accept');
      }
      return;
    }
    if (screen.kind === 'campfire') {
      const v = screen.view;
      const sealed = (id: string) => Object.values(v.lanes).some((l) => l.some((c) => c.id === id && c.sealed));
      if (target.kind === 'card' && target.cardId === cardId) return this.notice('A card cannot stack on itself.');
      if (sealed(cardId) || (target.kind === 'card' && sealed(target.cardId))) return this.notice(A.SEALED);
      if (target.kind === 'card') {
        const onShelf = v.piles.shelf.some((c) => c.id === cardId);
        if (onShelf) return this.commit(this.state, { pending: { kind: 'swap', shelfId: cardId, deckId: target.cardId } });
        const t = v.threads.find((x) => x.members.includes(cardId) && x.members.includes(target.cardId));
        if (!t) return this.notice('These two cards neither stack nor disagree.');
        const focus = { a: cardId, b: target.cardId, threadId: t.id };
        return this.commit(A.actFocusPair(this.state, focus), { pending: { kind: 'stack', ...focus, members: t.members } });
      }
      if (target.kind === 'fire') return this.commit(this.state, { pending: { kind: 'cut', cardId } });
      if (target.kind === 'book-retarget' || target.kind === 'book') {
        const targets = A.retargetFor(this.state, cardId, target.lane);
        const card = v.lanes.both.concat(v.lanes.claude, v.lanes.codex).find((c) => c.id === cardId);
        if (!targets || !card) return this.notice('A line from your file stays in that file. Merge it with a card to share it.');
        if (targets === card.targets) return this.notice('Already in that file. Narrow it from the inspector.');
        return this.commit(this.state, { pending: { kind: 'retarget', cardId, targets } });
      }
      return;
    }
    if (screen.kind === 'boss' && target.kind === 'head') {
      const next = A.actBossAnswer(this.state, cardId, target.caseId);
      if (next === this.state) return this.notice(screen.view.candidates.find((c) => c.cardId === cardId)?.reason ?? C_NO_ELIGIBLE);
      return this.commit(next, {}, 'boss-answer');
    }
  }

  /** Run an async Apply act once at a time: busy while it runs, refused while another is in flight. */
  private async applyAct(busy: C.ApplyView['busy'], f: (s: A.PlayState, p: A.ApplyPort) => Promise<A.PlayState>): Promise<void> {
    const p = this.port;
    if (!p || this.state.apply.busy !== 'idle') return;
    this.commit(A.actBusy(this.state, busy));
    const next = await f(this.state, p);
    this.commit(A.actBusy(next, 'idle'));
  }

  private buildApi(): C.ControllerApi {
    const run = (f: (s: A.PlayState) => A.PlayState) => () => this.commit(f(this.state));
    return {
      stamp: (caseId, stamp) => this.commit(A.actStamp(this.state, caseId, stamp), { beat: 'judge' }, 'stamp'),
      focusReceipt: (caseId) => this.commit(A.actFocusReceipt(this.state, caseId)),
      deal: () => {
        this.commit(A.actDeal(this.state), { beat: 'deal' });
        // The first dealt card is selected with its beast reading on screen, so one Enter plays a line already shown.
        const s = this.screen();
        const first = (s.kind === 'room' || s.kind === 'event') && s.view.phase === 'dealt' ? s.view.hand[0] : undefined;
        if (first) this.api.select(first.id);
      },
      pullBack: () => this.commit(A.actPullBack(this.state), { beat: 'judge', selected: null }),
      skip: () => this.drop(this.ui.selected ?? '', { kind: 'shelf' }),
      advance: run(A.actAdvance),
      answerExisting: (cardId, caseId, yes) => this.commit(A.actAnswerExisting(this.state, cardId, caseId, yes)),
      wording: (roomKey, text) => this.commit(A.actWording(this.state, roomKey, text)),
      confirmProject: (roomKey, projectKey) => this.commit(A.actConfirmProject(this.state, roomKey, projectKey), { selected: null }),
      select: (cardId) => {
        // Selecting a dealt card shows its reading on the beast at once, so tap–tap never accepts an unseen line.
        const screen = this.screen();
        const inHand = !!cardId && (screen.kind === 'room' || screen.kind === 'event') && screen.view.hand.some((c) => c.id === cardId);
        const drag = inHand ? { cardId: cardId!, target: { kind: 'beast' as const }, preview: A.selectDrag(this.state, cardId!, { kind: 'beast' }) } : null;
        this.ui = { ...this.ui, selected: cardId, notice: null, pending: null, drag };
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
        changePreview: (q) => ('threadId' in q ? A.selectChangePreview(this.state, { threadId: q.threadId, ...(q.text !== undefined ? { text: q.text } : {}), ...(q.settle ? { resolution: q.settle } : {}) }) : A.selectChangePreview(this.state, q)),
        // A seal ends the gesture: the selection clears, so the next tap starts a new one.
        fuse: (threadId, text) => this.commit(A.actFuse(this.state, threadId, text), { pending: null, selected: null }, 'fuse'),
        settle: (threadId, choice) => this.commit(A.actSettle(this.state, threadId, choice), { pending: null, selected: null }, 'settle'),
        cut: (cardId) => this.commit(A.actCut(this.state, cardId), { pending: null, selected: null }, 'cut'),
        restore: (cardId) => this.commit(A.actRestore(this.state, cardId), {}, 'restore'),
        sharpen: (cardId, text) => this.commit(A.actSharpen(this.state, cardId, text), {}, 'sharpen'),
        retarget: (cardId, targets) => this.commit(A.actRetarget(this.state, cardId, targets), { pending: null, selected: null }, 'retarget'),
        swap: (shelfId, deckId) => this.commit(A.actSwap(this.state, shelfId, deckId), { pending: null, selected: null }, 'swap'),
        acceptMapping: (cardId, caseId) => this.commit(A.actAcceptMapping(this.state, cardId, caseId), {}, 'accept'),
        acceptImport: (cardId) => this.commit(A.actAcceptImport(this.state, cardId), {}, 'accept'),
        raiseAllowance: (lane, to) => this.commit(A.actRaiseAllowance(this.state, lane, to)),
      },
      boss: {
        stamp: (caseId, stamp) => this.commit(A.actBossStamp(this.state, caseId, stamp)),
        answer: (cardId, caseId) => this.drop(cardId, { kind: 'head', caseId }),
        // A new head clears the selection: the next head's candidates are not this one's.
        next: () => this.commit(A.actBossNext(this.state), { selected: null, cardIndex: 0 }),
      },
      apply: {
        grant: (which) => this.applyAct('granting', (s, p) => A.actGrant(s, p, which)),
        prepare: () => this.applyAct('preparing', A.actPrepareApply),
        seal: () => this.applyAct('sealing', A.actSeal),
        undo: () => this.applyAct('undoing', A.actUndo),
        returnToCampfire: (select) => this.commit(A.actReturnToCampfire(this.state, select)),
        // Keeping the receipt changes no game state: the view re-reads the port, so the screen is rebuilt here.
        remember: (on) => {
          if (!this.port?.remember) return;
          this.port.remember(on ? A.applyRecord(this.state) : null);
          this.cached = null;
          this.emit();
        },
      },
    };
  }
}

const C_NO_ELIGIBLE = 'No eligible card';
