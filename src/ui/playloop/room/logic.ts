// Owner: room/rig. Pure presentation logic for the room (no DOM, no engine): which controls show and when they wait,
// which heads animate for which result or effect, where head tags go. Every number printed comes from a view field;
// the only arithmetic here is placing rectangles and staggering animations.

import type { CommitEffectView, HeadView, RoomView, UiView } from '../contract';
import { COPY } from '../contract';

// ------------------------------------------------------------------ controls and the review lock

export type ControlId = 'deal' | 'pull-back' | 'continue' | 'keep-existing' | 'skip';

export interface Control {
  id: ControlId;
  label: string;
  enabled: boolean;
  /** Why the control waits, shown beside it (the review lock). */
  why: string | null;
}

/** "2 heads still to stamp" from review.remaining; null when nothing is left. */
export function reviewText(v: RoomView): string | null {
  const n = v.review.remaining;
  if (n <= 0) return null;
  return `${n} ${n === 1 ? 'head' : 'heads'} still to stamp`;
}

/**
 * The room's controls (§0a.13, §0a.14, CONTRACT.md rule 9): Deal when canDeal; Pull the hand back while dealt;
 * Continue or Keep existing from the offer; Continue after the play. Deal and every Continue wait for
 * review.canFinalize. Skip shows only when it is the one way out of a judged room (no hand to deal, no offer).
 */
export function roomControls(v: RoomView): Control[] {
  const lock = v.review.canFinalize ? null : reviewText(v);
  const out: Control[] = [];
  if (v.phase === 'done') {
    out.push({ id: 'continue', label: 'Continue', enabled: true, why: null });
    return out;
  }
  if (v.phase === 'dealt') {
    out.push({ id: 'pull-back', label: 'Pull the hand back', enabled: true, why: null });
    return out;
  }
  // judge
  if (v.kind === 'event') {
    out.push({ id: 'continue', label: 'Continue', enabled: v.review.canFinalize, why: lock });
    return out;
  }
  const dealable = v.canDeal || (!v.review.canFinalize && v.offer === null);
  if (dealable) out.push({ id: 'deal', label: 'Deal', enabled: v.canDeal && v.review.canFinalize, why: v.canDeal ? null : lock });
  if (v.offer === 'continue-all-set-aside') out.push({ id: 'continue', label: 'Continue', enabled: v.review.canFinalize, why: lock });
  if (v.offer === 'keep-existing') out.push({ id: 'keep-existing', label: 'Keep existing', enabled: v.review.canFinalize, why: lock });
  if (!v.canDeal && v.offer === null && v.review.canFinalize && v.canSkip) out.push({ id: 'skip', label: 'Skip this room · free', enabled: true, why: null });
  return out;
}

/** The lines under the controls: the finalizes line while dealt, the pull-back hint. */
export function controlLines(v: RoomView): string[] {
  const lines: string[] = [];
  if (v.finalizes) lines.push(v.finalizes);
  if (v.phase === 'dealt') lines.push(COPY.pullBack);
  return lines;
}

// ------------------------------------------------------------------ animation cues (once per result or effect id)

export interface HeadCue {
  key: string;
  /** Stagger in ms from the start of the cascade. */
  offset: number;
}

/** The bind cascade's step (§12.5). */
export const BIND_STAGGER = 90;
export const STRIKE_STAGGER = 120;

/**
 * Which heads fold, in which order: result.bound for the room's play (date order, 90 ms apart), and ui.effect.bound
 * for binds that arrive later (an existing line accepted, a deck card dropped on a standing head). A head folds only
 * when its state is bound now. Keys carry the result or effect id, so a repaint never replays a fold.
 */
export function foldCues(v: RoomView, effect: CommitEffectView | null): Map<string, HeadCue> {
  const bound = new Set(v.heads.filter((h) => h.state === 'bound').map((h) => h.caseId));
  const out = new Map<string, HeadCue>();
  const r = v.result;
  if (r && r.played) r.bound.forEach((id, i) => bound.has(id) && out.set(id, { key: `fold:r${r.id}:${id}`, offset: i * BIND_STAGGER }));
  // A play's own effect repeats result.bound; only later commits (accept, fuse, boss answers) add folds here.
  if (effect && effect.kind !== 'play' && effect.kind !== 'forge' && effect.kind !== 'skip') {
    let i = 0;
    for (const id of effect.bound) if (bound.has(id) && !out.has(id)) out.set(id, { key: `fold:e${effect.id}:${id}`, offset: i++ * BIND_STAGGER });
  }
  return out;
}

/** Standing heads strike once while the beat is strike (§2 step 5): result.standing, in its order. */
export function strikeCues(v: RoomView, beat: UiView['beat']): Map<string, HeadCue> {
  const out = new Map<string, HeadCue>();
  const r = v.result;
  if (beat !== 'strike' || !r) return out;
  const standing = new Set(v.heads.filter((h) => h.state === 'standing').map((h) => h.caseId));
  r.standing.forEach((id, i) => standing.has(id) && out.set(id, { key: `strike:r${r.id}:${id}`, offset: i * STRIKE_STAGGER }));
  return out;
}

/**
 * The clear (§2 step 6): the paper boat only when pips.fully (all-set-aside and all-wrapped rooms never get it);
 * a room left with standing heads sinks with them.
 */
export function clearOf(v: RoomView): 'boat' | 'sink' | null {
  if (v.phase !== 'done') return null;
  if (v.beast.pips.fully) return 'boat';
  if (v.heads.some((h) => h.state === 'standing')) return 'sink';
  return null;
}

// ------------------------------------------------------------------ tags and rings

/** "4 failed runs", "1 edit": the count from the view, said with what it counts. */
export function ringsText(r: NonNullable<HeadView['rings']>): string {
  const one = r.counts === 'failed runs' ? 'failed run' : 'edit';
  return `${r.count} ${r.count === 1 ? one : r.counts}`;
}

/** "09-23" from "2026-09-23" for the tag; the full date stays in the label. */
export function shortDate(d: string | null): string | null {
  if (!d) return null;
  const m = /^\d{4}-(\d{2}-\d{2})$/.exec(d);
  return m ? m[1]! : d;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The gap between two rectangles (0 when they touch or overlap). */
export function gapBetween(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.max(dx, dy);
}

export interface TagRequest {
  caseId: string;
  /** Where the tag hangs: the head's collar, in stage px. */
  x: number;
  y: number;
  /** Width of the full strip (sigil, project chip, date), each part at least 44 px. */
  fullW: number;
}

export interface TagPlacement extends Box {
  caseId: string;
  mode: 'full' | 'compact';
}

/**
 * Hang one tag per head (§0a.19: every hit region ≥ 44 px, ≥ 8 px apart). All heads get the full strip when every strip
 * fits; otherwise every head gets the compact knob (the agent sigil, 44 px) and the slip carries the current head's full
 * tag. A head whose tag cannot fit anywhere near it gets none (its head stays the hit region). Requests come in socket
 * order, so the anchor head is placed first.
 */
export function packTags(reqs: readonly TagRequest[], o: { bounds: { w: number; h: number }; h?: number; gap?: number; compactW?: number }): TagPlacement[] {
  const h = o.h ?? 44;
  const gap = o.gap ?? 8;
  const tryMode = (mode: 'full' | 'compact', all: boolean): TagPlacement[] | null => {
    const placed: TagPlacement[] = [];
    for (const r of reqs) {
      const w = mode === 'full' ? r.fullW : (o.compactW ?? 44);
      const step = h + gap;
      const spots = [0, step, -step, 2 * step].flatMap((dy) => [0, -w / 2 - gap, w / 2 + gap].map((dx) => ({ dx, dy })));
      let ok: TagPlacement | null = null;
      for (const s of spots) {
        const x = Math.round(Math.min(Math.max(0, r.x - w / 2 + s.dx), o.bounds.w - w));
        const y = Math.round(Math.min(Math.max(0, r.y + s.dy), o.bounds.h - h));
        const box = { caseId: r.caseId, mode, x, y, w, h };
        if (placed.every((p) => gapBetween(p, box) >= gap)) {
          ok = box;
          break;
        }
      }
      if (ok) placed.push(ok);
      else if (all) return null;
    }
    return placed;
  };
  return tryMode('full', true) ?? tryMode('compact', false) ?? [];
}
