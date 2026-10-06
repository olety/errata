// The drag core (play-loop §3, §0a.15, §0a.19). Pointer events become drags, taps and long-presses; drops resolve by
// hit-testing registered targets. A drag starts after 6 px; a 450 ms press opens the inspector; Escape cancels. On
// touch, tap–tap is the primary path and a mostly horizontal move scrolls the hand: it never plays a card.
// The gesture logic and the hit test are pure functions (tested without a DOM); DragCore binds them to elements.

import type { DragTarget } from './contract';

export const DRAG_START_PX = 6;
export const LONG_PRESS_MS = 450;
export const MIN_TARGET_PX = 44;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PointerKind = 'mouse' | 'touch' | 'pen';

// ------------------------------------------------------------------ pure: hit test

/** Which target is under the point. The smallest containing rectangle wins, so a head beats the beast around it. */
export function hitTest(regs: readonly { target: DragTarget; rect: Rect }[], x: number, y: number): DragTarget | null {
  let best: { target: DragTarget; area: number } | null = null;
  for (const r of regs) {
    const { x: rx, y: ry, w, h } = r.rect;
    if (x < rx || y < ry || x > rx + w || y > ry + h) continue;
    const area = w * h;
    if (!best || area < best.area) best = { target: r.target, area };
  }
  return best?.target ?? null;
}

/** Targets smaller than 44 × 44 px (§0a.19). Registering one is a layout bug; the debug render lists them. */
export function undersized(regs: readonly { id: string; rect: Rect }[]): string[] {
  return regs.filter((r) => r.rect.w < MIN_TARGET_PX || r.rect.h < MIN_TARGET_PX).map((r) => r.id);
}

// ------------------------------------------------------------------ pure: one pointer's gesture

export type Gesture =
  | { kind: 'idle' }
  | { kind: 'pressed'; cardId: string; x0: number; y0: number; t0: number; pointer: PointerKind }
  | { kind: 'dragging'; cardId: string; x: number; y: number }
  | { kind: 'scrolling' }
  | { kind: 'long-pressed'; cardId: string };

export type GestureEvent =
  | { type: 'down'; cardId: string; x: number; y: number; t: number; pointer: PointerKind }
  | { type: 'move'; x: number; y: number; t: number }
  | { type: 'up'; x: number; y: number; t: number }
  | { type: 'tick'; t: number }
  | { type: 'cancel' };

export type GestureOutput =
  | { type: 'start-drag'; cardId: string; x: number; y: number }
  | { type: 'move'; cardId: string; x: number; y: number }
  | { type: 'drop'; cardId: string; x: number; y: number }
  | { type: 'tap'; cardId: string }
  | { type: 'inspect'; cardId: string }
  | { type: 'cancel'; cardId: string }
  | null;

export const IDLE: Gesture = { kind: 'idle' };

export function stepGesture(g: Gesture, e: GestureEvent): [Gesture, GestureOutput] {
  switch (e.type) {
    case 'down':
      return [{ kind: 'pressed', cardId: e.cardId, x0: e.x, y0: e.y, t0: e.t, pointer: e.pointer }, null];
    case 'move': {
      if (g.kind === 'dragging') return [{ ...g, x: e.x, y: e.y }, { type: 'move', cardId: g.cardId, x: e.x, y: e.y }];
      if (g.kind !== 'pressed') return [g, null];
      const dx = e.x - g.x0;
      const dy = e.y - g.y0;
      if (Math.hypot(dx, dy) < DRAG_START_PX) return [g, null];
      // A touch that moves mostly sideways is the hand scrolling: it never becomes a drag or a play.
      if (g.pointer === 'touch' && Math.abs(dx) > Math.abs(dy)) return [{ kind: 'scrolling' }, null];
      return [{ kind: 'dragging', cardId: g.cardId, x: e.x, y: e.y }, { type: 'start-drag', cardId: g.cardId, x: e.x, y: e.y }];
    }
    case 'tick':
      if (g.kind === 'pressed' && e.t - g.t0 >= LONG_PRESS_MS) return [{ kind: 'long-pressed', cardId: g.cardId }, { type: 'inspect', cardId: g.cardId }];
      return [g, null];
    case 'up':
      if (g.kind === 'dragging') return [IDLE, { type: 'drop', cardId: g.cardId, x: e.x, y: e.y }];
      if (g.kind === 'pressed') return [IDLE, e.t - g.t0 >= LONG_PRESS_MS ? { type: 'inspect', cardId: g.cardId } : { type: 'tap', cardId: g.cardId }];
      return [IDLE, null];
    case 'cancel':
      if (g.kind === 'dragging' || g.kind === 'pressed') return [IDLE, g.kind === 'dragging' ? { type: 'cancel', cardId: g.cardId } : null];
      return [IDLE, null];
  }
}

// ------------------------------------------------------------------ DOM binding

export interface DragHooks {
  /** A drag began: the controller sets ui.drag. */
  onStart(cardId: string): void;
  /** The pointer is over this target (null: none); the controller asks the adapter for the preview. */
  onHover(cardId: string, target: DragTarget | null, at: { x: number; y: number }): void;
  onDrop(cardId: string, target: DragTarget | null): void;
  onCancel(cardId: string): void;
  /** Tap–tap: the first tap selects the card. */
  onTap(cardId: string): void;
  /** Long-press, right-click, F or the external Inspect control. */
  onInspect(cardId: string): void;
  /** A tap on a registered target while a card is selected. */
  onTapTarget(target: DragTarget): void;
  /** The paper ribbon from the card to the pointer; `to` null clears it. Skipped under reduced motion by the renderer. */
  ribbon?(from: { x: number; y: number }, to: { x: number; y: number } | null): void;
}

interface Reg {
  id: string;
  target: DragTarget;
  el: Element;
}

const kindOf = (e: PointerEvent): PointerKind => (e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse');

/** Binds cards and targets to pointer input. One drag at a time. Call destroy() when the screen unmounts. */
export class DragCore {
  private regs = new Map<string, Reg>();
  private g: Gesture = IDLE;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private from: { x: number; y: number } | null = null;
  private last: DragTarget | null = null;
  private off: (() => void)[] = [];

  constructor(
    private hooks: DragHooks,
    private win: Window = window,
  ) {
    const move = (e: PointerEvent) => this.feed({ type: 'move', x: e.clientX, y: e.clientY, t: e.timeStamp });
    const up = (e: PointerEvent) => this.feed({ type: 'up', x: e.clientX, y: e.clientY, t: e.timeStamp });
    const cancel = () => this.feed({ type: 'cancel' });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', cancel);
    win.addEventListener('keydown', key);
    this.off.push(() => win.removeEventListener('pointermove', move), () => win.removeEventListener('pointerup', up), () => win.removeEventListener('pointercancel', cancel), () => win.removeEventListener('keydown', key));
  }

  /** Make an element a drop and tap target. Returns the unregister function. */
  bindTarget(id: string, target: DragTarget, el: HTMLElement): () => void {
    this.regs.set(id, { id, target, el });
    const click = () => {
      if (this.g.kind === 'idle') this.hooks.onTapTarget(target);
    };
    el.addEventListener('click', click);
    return () => {
      this.regs.delete(id);
      el.removeEventListener('click', click);
    };
  }

  /** Make an element a draggable card. Right-click opens the inspector. */
  bindCard(cardId: string, el: HTMLElement): () => void {
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.from = { x: e.clientX, y: e.clientY };
      this.feed({ type: 'down', cardId, x: e.clientX, y: e.clientY, t: e.timeStamp, pointer: kindOf(e) });
      this.timer = setTimeout(() => this.feed({ type: 'tick', t: e.timeStamp + LONG_PRESS_MS }), LONG_PRESS_MS);
    };
    const context = (e: MouseEvent) => {
      e.preventDefault();
      this.hooks.onInspect(cardId);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('contextmenu', context);
    el.style.touchAction = 'pan-x';
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('contextmenu', context);
    };
  }

  /** The registered targets with their current rectangles. */
  rects(): { id: string; target: DragTarget; rect: Rect }[] {
    return [...this.regs.values()].map((r) => {
      const b = r.el.getBoundingClientRect();
      return { id: r.id, target: r.target, rect: { x: b.left, y: b.top, w: b.width, h: b.height } };
    });
  }

  cancel(): void {
    this.feed({ type: 'cancel' });
  }

  destroy(): void {
    this.cancel();
    for (const f of this.off) f();
    this.regs.clear();
  }

  private feed(e: GestureEvent): void {
    const [next, out] = stepGesture(this.g, e);
    this.g = next;
    if (next.kind !== 'pressed' && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!out) return;
    switch (out.type) {
      case 'start-drag':
        this.hooks.onStart(out.cardId);
        this.hover(out.cardId, out.x, out.y);
        break;
      case 'move':
        this.hover(out.cardId, out.x, out.y);
        break;
      case 'drop':
        this.hooks.ribbon?.(this.from ?? { x: out.x, y: out.y }, null);
        this.hooks.onDrop(out.cardId, hitTest(this.rects(), out.x, out.y));
        this.last = null;
        break;
      case 'tap':
        this.hooks.onTap(out.cardId);
        break;
      case 'inspect':
        this.hooks.onInspect(out.cardId);
        break;
      case 'cancel':
        this.hooks.ribbon?.(this.from ?? { x: 0, y: 0 }, null);
        this.hooks.onCancel(out.cardId);
        this.last = null;
        break;
    }
  }

  private hover(cardId: string, x: number, y: number): void {
    this.hooks.ribbon?.(this.from ?? { x, y }, { x, y });
    const t = hitTest(this.rects(), x, y);
    if (JSON.stringify(t) === JSON.stringify(this.last)) return;
    this.last = t;
    this.hooks.onHover(cardId, t, { x, y });
  }
}
