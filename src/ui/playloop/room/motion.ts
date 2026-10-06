// Owner: room/rig. The motion clock: the mount rebuilds the DOM on every paint, so a CSS animation would restart on each
// repaint. A cue remembers when its key was first seen and hands back a negative delay, so a repaint mid-animation
// continues where it was and a repaint after it shows the static end state. Keys carry the result or effect id, so
// each committed change animates once (CONTRACT.md rule 5). Nothing here waits: every cue is a hint to CSS, and
// flush() ends every running cue at once when the player acts (the next input moves on).

const seen = new Map<string, number>();
let flushedAt = -Infinity;

export interface Cue {
  /** True while the animation should still be running. */
  play: boolean;
  /** CSS animation-delay in ms (negative: already running for that long). */
  delay: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Start (or continue) the animation keyed by `key`, `duration` ms long, starting `offset` ms after first sight (a
 * stagger). Returns play:false once it has run, or after flush().
 */
export function cue(key: string, duration: number, offset = 0, t = now()): Cue {
  let t0 = seen.get(key);
  if (t0 === undefined) {
    t0 = t;
    seen.set(key, t0);
    if (seen.size > 400) prune(t);
  }
  if (t0 <= flushedAt) return { play: false, delay: 0 };
  const elapsed = t - t0;
  if (elapsed >= offset + duration) return { play: false, delay: 0 };
  return { play: true, delay: Math.round(offset - elapsed) };
}

/** True when the key has been seen before (its animation started on an earlier paint). */
export function started(key: string): boolean {
  return seen.has(key);
}

/** End every running animation now: the next paint shows end states. Called before the room's own acts. */
export function flush(t = now()): void {
  flushedAt = t;
}

/** Forget every key (tests). */
export function resetMotion(): void {
  seen.clear();
  flushedAt = -Infinity;
}

function prune(t: number): void {
  for (const [k, t0] of seen) if (t - t0 > 60_000) seen.delete(k);
}

/** Apply a cue to an element: the class while it plays, with its delay. Returns whether it plays. */
export function animate(el: HTMLElement | SVGElement, cls: string, c: Cue): boolean {
  if (!c.play) return false;
  el.classList.add(cls);
  el.style.animationDelay = `${c.delay}ms`;
  return true;
}
