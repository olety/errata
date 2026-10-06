// The drag core's pure parts: gesture thresholds, touch scrolling, long-press, cancel, and the hit test.
import { describe, expect, test } from 'bun:test';
import { DRAG_START_PX, hitTest, IDLE, LONG_PRESS_MS, stepGesture, undersized, type Gesture, type GestureEvent, type GestureOutput } from '../src/ui/playloop/drag';

function run(events: GestureEvent[]): GestureOutput[] {
  let g: Gesture = IDLE;
  const out: GestureOutput[] = [];
  for (const e of events) {
    const [n, o] = stepGesture(g, e);
    g = n;
    if (o) out.push(o);
  }
  return out;
}

describe('gestures', () => {
  test('a drag starts only after 6 px, then moves and drops', () => {
    const out = run([
      { type: 'down', cardId: 'c', x: 0, y: 0, t: 0, pointer: 'mouse' },
      { type: 'move', x: DRAG_START_PX - 1, y: 0, t: 10 },
      { type: 'move', x: 0, y: DRAG_START_PX, t: 20 },
      { type: 'move', x: 40, y: 80, t: 30 },
      { type: 'up', x: 40, y: 80, t: 40 },
    ]);
    expect(out.map((o) => o!.type)).toEqual(['start-drag', 'move', 'drop']);
  });

  test('a short press is a tap; a 450 ms press opens the inspector and is not a tap', () => {
    expect(run([{ type: 'down', cardId: 'c', x: 0, y: 0, t: 0, pointer: 'touch' }, { type: 'up', x: 1, y: 1, t: 100 }])).toEqual([{ type: 'tap', cardId: 'c' }]);
    const long = run([{ type: 'down', cardId: 'c', x: 0, y: 0, t: 0, pointer: 'touch' }, { type: 'tick', t: LONG_PRESS_MS }, { type: 'up', x: 0, y: 0, t: LONG_PRESS_MS + 50 }]);
    expect(long).toEqual([{ type: 'inspect', cardId: 'c' }]);
  });

  test('a sideways touch scrolls the hand and never plays a card; a mouse drag sideways is a drag', () => {
    const touch = run([{ type: 'down', cardId: 'c', x: 0, y: 0, t: 0, pointer: 'touch' }, { type: 'move', x: 30, y: 4, t: 10 }, { type: 'move', x: 30, y: 200, t: 20 }, { type: 'up', x: 30, y: 200, t: 30 }]);
    expect(touch).toEqual([]);
    const mouse = run([{ type: 'down', cardId: 'c', x: 0, y: 0, t: 0, pointer: 'mouse' }, { type: 'move', x: 30, y: 4, t: 10 }, { type: 'up', x: 30, y: 4, t: 20 }]);
    expect(mouse.map((o) => o!.type)).toEqual(['start-drag', 'drop']);
  });

  test('Escape cancels a drag: no drop follows', () => {
    const out = run([{ type: 'down', cardId: 'c', x: 0, y: 0, t: 0, pointer: 'mouse' }, { type: 'move', x: 0, y: 50, t: 10 }, { type: 'cancel' }, { type: 'up', x: 0, y: 50, t: 20 }]);
    expect(out.map((o) => o!.type)).toEqual(['start-drag', 'cancel']);
  });
});

describe('hit test', () => {
  const regs = [
    { id: 'beast', target: { kind: 'beast' as const }, rect: { x: 0, y: 0, w: 400, h: 400 } },
    { id: 'head', target: { kind: 'head' as const, caseId: 'h1' }, rect: { x: 100, y: 100, w: 60, h: 60 } },
    { id: 'claude', target: { kind: 'book' as const, lane: 'claude' as const }, rect: { x: 0, y: 500, w: 144, h: 200 } },
    { id: 'tiny', target: { kind: 'shelf' as const }, rect: { x: 600, y: 600, w: 30, h: 30 } },
  ];
  test('the smallest containing target wins; outside every target is null', () => {
    expect(hitTest(regs, 120, 120)).toEqual({ kind: 'head', caseId: 'h1' });
    expect(hitTest(regs, 300, 300)).toEqual({ kind: 'beast' });
    expect(hitTest(regs, 10, 600)).toEqual({ kind: 'book', lane: 'claude' });
    expect(hitTest(regs, 450, 450)).toBeNull();
  });
  test('targets under 44 px are reported', () => {
    expect(undersized(regs)).toEqual(['tiny']);
  });
});
