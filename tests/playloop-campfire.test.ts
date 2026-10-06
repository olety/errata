// The campfire's pure helpers (src/ui/playloop/campfire/model.ts) and, on the synthetic sample through the real
// controller, the rule they serve: stacking proposes, sealing performs, every change previews through the api first,
// cancel leaves the thread, a refused preview never seals.
import { beforeAll, describe, expect, test } from 'bun:test';
import { newDeck } from '../src/deck/deck';
import * as A from '../src/ui/playloop/adapter';
import * as M from '../src/ui/playloop/campfire/model';
import type { CampfireView, ChangePreviewView, ControllerApi, ThreadView } from '../src/ui/playloop/contract';
import { Controller } from '../src/ui/playloop/controller';
import { layout } from '../src/ui/playloop/geometry';
import { sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let fresh: () => Controller;
beforeAll(async () => {
  const an = await sampleAnalysis();
  fresh = () => new Controller(A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true }), null, { viewport: { w: 1440, h: 900 } });
});

/** Room 1 played on the beast (or into CLAUDE.md), the event set aside as a change of plan: the first campfire. */
function toCampfire(play: 'beast' | 'claude' = 'beast'): Controller {
  const c = fresh();
  for (let i = 0; i < 3; i++) c.key('a');
  c.key('Enter');
  if (play === 'beast') c.key('Enter');
  else {
    c.key('1');
    c.key('1');
  }
  c.key('Enter');
  c.key('c');
  c.key('Enter');
  expect(c.screen().kind).toBe('campfire');
  return c;
}

function fire(c: Controller): CampfireView {
  const s = c.screen();
  if (s.kind !== 'campfire') throw new Error(`not at a campfire: ${s.kind}`);
  return s.view;
}

const noDrafts = (): M.Drafts => ({ fuse: {}, settle: {}, edit: null });

/** The screen's own pipeline: the proposal on the table, its api preview, and the seal it allows. */
function pipeline(c: Controller, drafts: M.Drafts = noDrafts()) {
  const v = fire(c);
  const p = M.proposalOf(v, c.ui.pending, drafts);
  const q = p ? M.queryOf(p) : null;
  const preview = q ? c.api.campfire.changePreview(q) : null;
  return { v, p, q, preview, seal: p ? M.sealOf(p, preview) : { call: null, why: null } };
}

const thread = (over: Partial<ThreadView> = {}): ThreadView => ({ id: 'a+b', color: 'gold', members: ['a', 'b'], reason: 'the same words', autoText: null, ...over });

const preview = (over: Partial<ChangePreviewView> = {}): ChangePreviewView => {
  const g = { before: 10, after: 8, delta: -2, line: -2, blockHeader: 0, other: 0, text: '−2' };
  return { before: [], after: null, resultId: null, refused: null, lines: [], ghost: { claude: g, codex: { ...g, before: 5, after: 5, delta: 0, line: 0, text: 'no change' } }, cases: { affected: 0, deckBefore: 1, deckAfter: 1, opened: [], addressed: [], text: 'Affected cases: 0 · deck total: 1 → 1' }, needsAcceptance: [], refs: [], ...over };
};

describe('the seal: a 0.6 s hold or Enter', () => {
  test('a hold of HOLD_MS seals, an earlier release only lets go, an unsealable press never holds', () => {
    let [h, go] = M.holdStep(M.HOLD_IDLE, { type: 'down', t: 1000, sealable: true });
    expect(h).toEqual({ kind: 'holding', t0: 1000 });
    [h, go] = M.holdStep(h, { type: 'tick', t: 1000 + M.HOLD_MS - 1 });
    expect(go).toBe(false);
    expect(M.holdStep(h, { type: 'tick', t: 1000 + M.HOLD_MS })).toEqual([M.HOLD_IDLE, true]);
    expect(M.holdStep(h, { type: 'up', t: 1250 })).toEqual([M.HOLD_IDLE, false]);
    expect(M.holdStep(h, { type: 'up', t: 1000 + M.HOLD_MS })).toEqual([M.HOLD_IDLE, true]);
    expect(M.holdStep(h, { type: 'cancel' })).toEqual([M.HOLD_IDLE, false]);
    expect(M.holdStep(M.HOLD_IDLE, { type: 'down', t: 0, sealable: false })).toEqual([M.HOLD_IDLE, false]);
    expect(M.holdStep(M.HOLD_IDLE, { type: 'tick', t: 99999 })).toEqual([M.HOLD_IDLE, false]);
    expect(M.HOLD_MS).toBe(600);
  });

  test('Enter seals a sealable proposal, is swallowed by one that cannot seal, leaves our controls alone and otherwise passes', () => {
    expect(M.enterAction({ proposal: true, sealable: true, target: 'other' })).toBe('seal');
    expect(M.enterAction({ proposal: true, sealable: true, target: 'field' })).toBe('seal');
    expect(M.enterAction({ proposal: true, sealable: true, target: 'seal' })).toBe('seal');
    expect(M.enterAction({ proposal: true, sealable: false, target: 'other' })).toBe('block');
    expect(M.enterAction({ proposal: true, sealable: true, target: 'control' })).toBe('own');
    expect(M.enterAction({ proposal: false, sealable: false, target: 'control' })).toBe('own');
    expect(M.enterAction({ proposal: false, sealable: false, target: 'other' })).toBe('pass');
    expect(M.enterAction({ proposal: true, sealable: true, target: 'outside-field' })).toBe('pass');
    expect(M.keyTarget('TEXTAREA', false, true)).toBe('field');
    expect(M.keyTarget('input', false, false)).toBe('outside-field');
    expect(M.keyTarget('BUTTON', true, true)).toBe('seal');
    expect(M.keyTarget('BUTTON', false, true)).toBe('control');
    expect(M.keyTarget('DIV', false, true)).toBe('other');
    expect(M.keyTarget(undefined, false, false)).toBe('other');
  });
});

describe('proposals, queries and seals (pure)', () => {
  test('a gold thread without automatic text opens an editor holding every line; it previews and seals only as one line', () => {
    const t = thread();
    const v = { threads: [t], projects: [], lanes: { claude: [], both: [], codex: [] }, piles: { shelf: [], shelfCount: 0, open: [], openCount: 0 }, ash: [] } as unknown as CampfireView;
    const pending = { kind: 'stack' as const, a: 'a', b: 'b', threadId: t.id, members: t.members };
    const p = M.proposalOf(v, pending, noDrafts())!;
    expect(p.kind).toBe('fuse');
    if (p.kind !== 'fuse') return;
    expect(p.editing).toBe(true);
    expect(M.queryOf(p)).toBeNull();
    expect(M.sealOf(p, null)).toEqual({ call: null, why: 'Write the merged line on one line to see it.' });
    const two = { ...p, text: 'Use uv.\nNever pip.' };
    expect(M.queryOf(two)).toBeNull();
    const one = { ...p, text: '  Use uv, never pip.  ' };
    expect(M.queryOf(one)).toEqual({ threadId: t.id, text: 'Use uv, never pip.' });
    expect(M.sealOf(one, preview()).call).toEqual({ kind: 'fuse', threadId: t.id, text: 'Use uv, never pip.' });
    expect(M.sealOf(one, preview({ refused: 'Protected text cannot be stacked.' }))).toEqual({ call: null, why: 'Protected text cannot be stacked.' });
  });

  test('a gold thread with automatic text previews by thread id and seals that text unless the player edits it', () => {
    const t = thread({ autoText: 'Use uv, not pip.' });
    const v = { threads: [t], projects: [], lanes: { claude: [], both: [], codex: [] }, piles: { shelf: [], shelfCount: 0, open: [], openCount: 0 }, ash: [] } as unknown as CampfireView;
    const pending = { kind: 'stack' as const, a: 'b', b: 'a', threadId: t.id, members: t.members };
    const p = M.proposalOf(v, pending, noDrafts())!;
    expect(p).toMatchObject({ kind: 'fuse', editing: false, top: 'b', under: 'a' });
    expect(M.queryOf(p)).toEqual({ threadId: t.id });
    expect(M.sealOf(p, preview()).call).toEqual({ kind: 'fuse', threadId: t.id, text: 'Use uv, not pip.' });
    const edited = M.proposalOf(v, pending, { ...noDrafts(), fuse: { [t.id]: { editing: true, text: 'Use uv for installs, not pip.' } } })!;
    expect(M.queryOf(edited)).toEqual({ threadId: t.id, text: 'Use uv for installs, not pip.' });
  });

  test('a stack whose thread is gone cannot seal; a drop wins over a campfire edit; an edit of a card not in the deck is dropped', () => {
    const v = { threads: [], projects: [], lanes: { claude: [{ id: 'k' }], both: [], codex: [] }, piles: { shelf: [], shelfCount: 0, open: [], openCount: 0 }, ash: [] } as unknown as CampfireView;
    const gone = M.proposalOf(v, { kind: 'stack', a: 'a', b: 'b', threadId: 'x', members: ['a', 'b'] }, noDrafts())!;
    expect(gone.kind).toBe('gone');
    expect(M.sealOf(gone, preview()).call).toBeNull();
    const edit: M.Drafts = { ...noDrafts(), edit: { kind: 'sharpen', cardId: 'k', text: 'Shorter.' } };
    expect(M.proposalOf(v, { kind: 'cut', cardId: 'k' }, edit)).toEqual({ kind: 'cut', cardId: 'k' });
    expect(M.proposalOf(v, null, edit)).toEqual({ kind: 'sharpen', cardId: 'k', text: 'Shorter.' });
    expect(M.proposalOf(v, null, { ...noDrafts(), edit: { kind: 'sharpen', cardId: 'missing', text: 'x' } })).toBeNull();
    expect(M.proposalOf(v, { kind: 'confirm', cardId: 'k', target: { kind: 'beast' } }, noDrafts())).toBeNull();
    expect(M.proposalOf(v, null, { ...noDrafts(), edit: { kind: 'narrow', cardId: 'k', targets: 'claude' } })).toEqual({ kind: 'retarget', cardId: 'k', targets: 'claude', from: 'chips' });
  });

  test('the four red-pair slots map to the engine settlements; an incomplete slot is no choice', () => {
    const t = thread({ id: 'x×y', color: 'red', members: ['x', 'y'], reason: 'One card says to run full; the other says not to.' });
    const projects = [{ key: 'p1', label: 'pyramid' }];
    const d = M.defaultSettle(t, projects);
    expect(d).toMatchObject({ slot: null, keep: 'x', bind: 'x', on: 'x', projectKey: 'p1', when: 'always' });
    expect(M.settleChoice(d, t, projects)).toBeNull();
    expect(M.settleChoice({ ...d, slot: 'keep', keep: 'y' }, t, projects)).toEqual({ kind: 'keep', keep: 'y' });
    expect(M.settleChoice({ ...d, slot: 'keep', keep: 'z' }, t, projects)).toBeNull();
    expect(M.settleChoice({ ...d, slot: 'separate' }, t, projects)).toEqual({ kind: 'separate', bind: 'x', projectKey: 'p1', projectLabel: 'pyramid' });
    expect(M.settleChoice({ ...d, slot: 'separate' }, t, [])).toBeNull();
    expect(M.settleChoice({ ...d, slot: 'exception', text: '' }, t, projects)).toBeNull();
    expect(M.settleChoice({ ...d, slot: 'exception', text: 'unless asked\nor told' }, t, projects)).toBeNull();
    expect(M.settleChoice({ ...d, slot: 'exception', on: 'y', text: ' unless the user names a test file ' }, t, projects)).toEqual({ kind: 'exception', on: 'y', text: 'unless the user names a test file', when: {} });
    expect(M.settleChoice({ ...d, slot: 'exception', text: 'u', when: 'project', whenValue: 'p1' }, t, projects)).toMatchObject({ when: { projectKey: 'p1' } });
    expect(M.settleChoice({ ...d, slot: 'exception', text: 'u', when: 'command', whenValue: 'pytest tests/' }, t, projects)).toMatchObject({ when: { commandPrefix: 'pytest tests/' } });
    // A chosen condition must be complete: never an unconditional exception by accident.
    expect(M.settleChoice({ ...d, slot: 'exception', text: 'u', when: 'path', whenValue: ' ' }, t, projects)).toBeNull();
    expect(M.settleChoice({ ...d, slot: 'exception', text: 'u', when: 'command', whenValue: '' }, t, projects)).toBeNull();
    expect(M.settleChoice({ ...d, slot: 'exception', text: 'u', when: 'project', whenValue: 'nope' }, t, projects)).toBeNull();
    expect(M.settleChoice({ ...d, slot: 'exception', text: 'u', when: 'path', whenValue: 'src/legacy/' }, t, projects)).toMatchObject({ when: { pathPrefix: 'src/legacy/' } });
    const v = { threads: [t], projects, lanes: { claude: [], both: [], codex: [] }, piles: { shelf: [], shelfCount: 0, open: [], openCount: 0 }, ash: [] } as unknown as CampfireView;
    const p = M.proposalOf(v, { kind: 'stack', a: 'x', b: 'y', threadId: t.id, members: t.members }, noDrafts())!;
    expect(p).toMatchObject({ kind: 'settle', choice: null });
    expect(M.queryOf(p)).toBeNull();
    expect(M.sealOf(p, null).why).toBe('Pick how to settle the pair, and complete its fields.');
  });

  test('cut, swap, re-target and sharpen ask for their own preview and seal with their own call', () => {
    expect(M.queryOf({ kind: 'cut', cardId: 'k' })).toEqual({ cutId: 'k' });
    expect(M.queryOf({ kind: 'swap', shelfId: 's', deckId: 'd' })).toEqual({ swap: { shelfId: 's', deckId: 'd' } });
    expect(M.queryOf({ kind: 'retarget', cardId: 'k', targets: 'both', from: 'book' })).toEqual({ retarget: { cardId: 'k', targets: 'both' } });
    expect(M.queryOf({ kind: 'sharpen', cardId: 'k', text: '' })).toBeNull();
    expect(M.queryOf({ kind: 'sharpen', cardId: 'k', text: 'Run one file.' })).toEqual({ sharpen: { cardId: 'k', text: 'Run one file.' } });
    const calls: string[] = [];
    const api = { campfire: { fuse: (...a: unknown[]) => calls.push(`fuse ${a}`), settle: (t: string) => calls.push(`settle ${t}`), cut: (k: string) => calls.push(`cut ${k}`), swap: (s: string, d: string) => calls.push(`swap ${s} ${d}`), retarget: (k: string, t: string) => calls.push(`retarget ${k} ${t}`), sharpen: (k: string, t: string) => calls.push(`sharpen ${k} ${t}`) } } as unknown as ControllerApi;
    for (const p of [{ kind: 'cut', cardId: 'k' }, { kind: 'swap', shelfId: 's', deckId: 'd' }, { kind: 'retarget', cardId: 'k', targets: 'codex', from: 'chips' }, { kind: 'sharpen', cardId: 'k', text: 'Run one file.' }] as M.Proposal[]) {
      M.runSeal(api, M.sealOf(p, preview()).call!);
      expect(M.sealOf(p, preview({ refused: 'no' })).call).toBeNull();
    }
    expect(calls).toEqual(['cut k', 'swap s d', 'retarget k codex', 'sharpen k Run one file.']);
  });

  test('the books read the proposal as a drag preview with the api ghost itself; no proposal, no ghost', () => {
    const pv = preview();
    const sp = M.strapPreview({ kind: 'cut', cardId: 'k' }, pv)!;
    expect(sp.ghost).toBe(pv.ghost);
    expect(sp.verb).toBe('cut');
    expect(M.strapPreview({ kind: 'retarget', cardId: 'k', targets: 'claude', from: 'chips' }, pv)!.verb).toBe('narrow');
    expect(M.strapPreview(null, pv)).toBeNull();
    expect(M.strapPreview({ kind: 'cut', cardId: 'k' }, null)).toBeNull();
  });
});

describe('words, spans and stacks', () => {
  test('weight rows print the api ghost with estimated beside it; code spans split without parsing HTML', () => {
    expect(M.weightRows(preview().ghost)).toEqual([
      { file: 'CLAUDE.md', span: '10 → 8', delta: '−2', estimated: 'estimated' },
      { file: 'AGENTS.md', span: '5 → 5', delta: 'no change', estimated: 'estimated' },
    ]);
    expect(M.codeSpans('When testing with `pytest`, run `<b>x</b>` only')).toEqual([
      { code: false, text: 'When testing with ' },
      { code: true, text: 'pytest' },
      { code: false, text: ', run ' },
      { code: true, text: '<b>x</b>' },
      { code: false, text: ' only' },
    ]);
    expect(M.codeSpans('no code')).toEqual([{ code: false, text: 'no code' }]);
  });

  test('the hover line says what release proposes, or the refusal; never a verb the engine did not return', () => {
    const g = preview().ghost;
    const d = (verb: string, refused: string | null = null) => ({ cardId: 'k', target: { kind: 'fire' as const }, preview: { verb, heads: [], ghost: g, line: null, accepts: [], refused } }) as never;
    expect(M.hoverLine(d('cut'))).toContain('cut');
    expect(M.hoverLine(d('fuse'))).toContain('nothing changes yet');
    expect(M.hoverLine(d('none', 'These two cards neither stack nor disagree.'))).toBe('These two cards neither stack nor disagree.');
    expect(M.hoverLine(d('none'))).toBeNull();
    expect(M.hoverLine(null)).toBeNull();
  });

  test('a stack puts the dropped card on top of the card it landed on, the rest of the thread beneath; offsets snap at 22 px', () => {
    expect(M.stackOrder(['a', 'b', 'c'], 'b', 'c')).toEqual(['a', 'c', 'b']);
    expect(M.stackOrder(['a', 'b'], 'a', 'a')).toEqual(['b', 'a']);
    expect(M.stackOffset(3, 400, 246)).toBe(M.STACK_OFFSET);
    expect(M.stackOffset(3, 270, 246)).toBe(12);
    expect(M.stackOffset(3, 250, 246)).toBe(10);
    expect(M.stackOffset(1, 100, 246)).toBe(0);
  });
});

describe('geometry: the plate, the fire and the lane in the bands', () => {
  for (const [w, h] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    test(`${w}×${h}: the table edge meets the shore, the plate covers both bands, the candle stands under the fire`, () => {
      const b = layout({ w, h });
      const g = M.campfireGeometry(b);
      const s = g.plate.w / M.PLATE.w;
      expect(g.stage.h).toBe(b.sky.h + b.creature.h);
      expect(g.wood.h).toBe(b.wood.h);
      expect(Math.abs(g.plate.stage.y + M.PLATE.edgeY * s - g.stage.h)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.plate.wood.y + M.PLATE.edgeY * s)).toBeLessThanOrEqual(1);
      expect(g.plate.stage.y).toBeLessThanOrEqual(0);
      expect(g.plate.wood.y + g.plate.h).toBeGreaterThanOrEqual(g.wood.h);
      expect(g.plate.stage.x).toBeLessThanOrEqual(0);
      expect(g.plate.stage.x + g.plate.w).toBeGreaterThanOrEqual(w);
      expect(Math.abs(g.plate.wood.x + M.PLATE.candleX * s - (g.fire.x + g.fire.w / 2))).toBeLessThanOrEqual(1);
      expect(g.fire.w).toBeGreaterThanOrEqual(b.touch.min);
      expect(g.fire.h).toBeGreaterThanOrEqual(b.touch.min);
      expect(g.fire.y + g.fire.h).toBeLessThanOrEqual(g.wood.h);
      if (b.mode === 'phone') {
        expect(g.pairCard.size).toBe('S');
        expect(2 * g.pairCard.w + 48).toBeLessThanOrEqual(w - 2 * g.stage.pad);
        // Lane carousel, book tabs, then the pile rail beside the fire, all inside the wood.
        expect(g.fire.y).toBe(M.INSPECT_HEADROOM + b.card.h + 8 + b.touch.min + 8);
        expect(g.fire.x).toBeGreaterThanOrEqual(g.wood.pad + g.wood.piles + b.touch.gap);
        expect(g.fire.x + g.fire.w).toBeLessThanOrEqual(w - g.wood.pad);
      } else {
        expect(g.pairCard).toEqual({ size: 'M', w: b.card.w, h: b.card.h });
        // Books, fire, lane and piles fill the row exactly; the lane holds at least two M cards.
        expect(g.wood.pad + g.wood.books + g.wood.gap + g.fire.w + g.wood.gap + g.lane.w + g.wood.gap + g.wood.piles + g.wood.pad).toBe(w);
        expect(g.lane.w).toBeGreaterThanOrEqual(2 * b.card.w + b.cards.gap);
        expect(g.lane.x).toBe(g.wood.pad + g.wood.books + g.wood.gap + g.fire.w + g.wood.gap);
        expect(g.stage.cols![0] + g.stage.cols![1] + 2 * g.stage.pad + 2 * (b.mode === 'desktop' ? 24 : 16) + 2 * b.card.w).toBeLessThanOrEqual(w);
      }
    });
  }
});

describe('on the sample, through the controller', () => {
  test('stacking proposes: the deck is unchanged until the seal, and the seal is the api call the preview allowed', () => {
    const c = toCampfire();
    const uv = fire(c).threads.find((t) => t.color === 'gold' && t.members.length === 3)!;
    const weight = () => A.selectBooks(c.state).map((b) => b.weight.now);
    const before = weight();
    c.api.drop(uv.members[1]!, { kind: 'card', cardId: uv.members[0]! });
    expect(weight()).toEqual(before);
    const { p, q, preview: pv, seal } = pipeline(c);
    expect(p).toMatchObject({ kind: 'fuse', editing: false, top: uv.members[1], under: uv.members[0], members: uv.members });
    expect(q).toEqual({ threadId: uv.id });
    expect(pv!.cases.text).toBe('Affected cases: 0 · deck total: 3 → 3');
    expect(pv!.ghost.claude.text).toBe('−19');
    expect(seal.call).toEqual({ kind: 'fuse', threadId: uv.id, text: uv.autoText! });
    M.runSeal(c.api, seal.call!);
    expect(c.ui.pending).toBeNull();
    expect(weight()).toEqual([before[0]! + pv!.ghost.claude.delta, before[1]! + pv!.ghost.codex.delta]);
    expect(fire(c).threads.some((t) => t.id === uv.id)).toBe(false);
  });

  test('cancel leaves the thread: a stacked red pair cancelled keeps its thread and changes nothing', () => {
    const c = toCampfire();
    const red = fire(c).threads.find((t) => t.color === 'red')!;
    expect(red.reason.length).toBeGreaterThan(0);
    const deck = c.state.deck;
    c.api.drop(red.members[0]!, { kind: 'card', cardId: red.members[1]! });
    expect(pipeline(c).p).toMatchObject({ kind: 'settle', choice: null });
    c.api.cancel();
    expect(c.ui.pending).toBeNull();
    expect(c.state.deck).toBe(deck);
    expect(fire(c).threads.find((t) => t.id === red.id)!.reason).toBe(red.reason);
  });

  test('every red-pair slot shows the exported lines before the seal; the written exception seals as previewed', () => {
    const c = toCampfire();
    const v = fire(c);
    const red = v.threads.find((t) => t.color === 'red')!;
    c.api.drop(red.members[0]!, { kind: 'card', cardId: red.members[1]! });
    const base = M.defaultSettle(red, v.projects);
    const drafts = (d: Partial<M.SettleDraft>): M.Drafts => ({ ...noDrafts(), settle: { [red.id]: { ...base, ...d } } });
    const keep = pipeline(c, drafts({ slot: 'keep', keep: red.members[0]! }));
    expect(keep.preview!.lines.map((l) => l.text === null)).toEqual(red.members.map((m) => m !== red.members[0]));
    const sep = pipeline(c, drafts({ slot: 'separate' }));
    expect(sep.preview!.lines.length).toBe(2);
    expect(sep.preview!.lines.every((l) => l.text !== null && l.files.length > 0)).toBe(true);
    const full = v.lanes.codex.find((k) => k.inspector.exact === 'Run the full test suite before reporting done.')!;
    const exc = pipeline(c, drafts({ slot: 'exception', on: full.id, text: 'unless the user names a test file' }));
    expect(exc.preview!.lines.find((l) => l.id === full.id)!.text).toBe('Run the full test suite before reporting done, unless the user names a test file.');
    expect(exc.preview!.cases.text).toBe('Affected cases: 0 · deck total: 3 → 3');
    expect(exc.seal.call!.kind).toBe('settle');
    M.runSeal(c.api, exc.seal.call!);
    expect(fire(c).threads.some((t) => t.color === 'red')).toBe(false);
  });

  test('the fire proposes a cut with the reopened cases; the seal burns it into the ash; restore returns it', () => {
    const c = toCampfire();
    const card = fire(c).lanes.both[0]!;
    c.api.drop(card.id, { kind: 'fire' });
    const { p, preview: pv, seal } = pipeline(c);
    expect(p).toEqual({ kind: 'cut', cardId: card.id });
    expect(pv!.before.map((b) => b.id)).toEqual([card.id]);
    expect(pv!.cases.opened.length).toBe(3);
    expect(pv!.cases.text).toBe('Affected cases: 3 · deck total: 3 → 0');
    M.runSeal(c.api, seal.call!);
    expect(fire(c).ashCount).toBe(1);
    expect(fire(c).piles.openCount).toBe(3);
    expect(c.uiView().effect).toMatchObject({ kind: 'cut', unbound: expect.arrayContaining(pv!.cases.opened) });
    c.api.campfire.restore(card.id);
    expect(fire(c).ashCount).toBe(0);
    expect(fire(c).piles.openCount).toBe(0);
  });

  test('a book drop proposes writing to both files; the seal re-targets as previewed', () => {
    const c = toCampfire('claude');
    // A game card (a line read from your file stays in that file).
    const card = fire(c).lanes.claude.find((k) => k.type === 'rule' && k.provenance !== 'From your file')!;
    c.api.drop(card.id, { kind: 'book-retarget', lane: 'codex' });
    const { p, preview: pv, seal } = pipeline(c);
    expect(p).toEqual({ kind: 'retarget', cardId: card.id, targets: 'both', from: 'book' });
    expect(pv!.ghost.codex.text).toBe('+46 line · +23 block header');
    M.runSeal(c.api, seal.call!);
    expect(fire(c).lanes.both.map((k) => k.id)).toContain(card.id);
  });

  test('a sharpen previews the cases its new text must be accepted for; after the seal, acceptMapping binds them', () => {
    const c = toCampfire();
    const card = fire(c).lanes.both[0]!;
    const drafts: M.Drafts = { ...noDrafts(), edit: { kind: 'sharpen', cardId: card.id, text: 'When testing with `pytest`, run only the test file for the change.' } };
    const { preview: pv, seal } = pipeline(c, drafts);
    expect(pv!.resultId).toBe(card.id);
    expect(pv!.needsAcceptance.length).toBeGreaterThan(0);
    M.runSeal(c.api, seal.call!);
    const caseId = pv!.needsAcceptance[0]!;
    c.api.campfire.acceptMapping(pv!.resultId!, caseId);
    expect(c.uiView().effect).toMatchObject({ kind: 'accept', bound: [caseId] });
  });

  test('a pinned Open page lists eligibility, never coverage, and is no drop target', () => {
    const c = toCampfire('claude');
    const page = fire(c).piles.open[0]!;
    c.api.campfire.pin(page.caseId);
    const v = fire(c);
    expect(v.pinned!.caseId).toBe(page.caseId);
    expect(v.pinnedCandidates.every((k) => k.glow || (k.reason ?? '').length > 0)).toBe(true);
    expect(M.caseTag(page.caseId, v)).toBe(M.tagText(page.tag));
    expect(M.caseTag('not-a-case', v)).toBeNull();
  });

  test('a shelf swap at the second campfire previews and seals; a refused swap never seals', () => {
    const c = toCampfire();
    c.key('Enter');
    for (let room = 0; room < 3 && c.screen().kind !== 'campfire'; room++) {
      for (let i = 0; i < 5; i++) c.key('a');
      c.key('Enter');
      c.key('Enter');
      c.key('Enter');
    }
    const v = fire(c);
    expect(v.piles.shelfCount).toBeGreaterThan(0);
    const shelf = v.piles.shelf.find((k) => k.face.title === 'Report the result')!;
    const deck = [...v.lanes.claude, ...v.lanes.both, ...v.lanes.codex].find((k) => k.face.title === 'Verification gate')!;
    const wrong = [...v.lanes.claude, ...v.lanes.both, ...v.lanes.codex].find((k) => k.provenance === 'From your file' && !k.sealed)!;
    c.api.drop(shelf.id, { kind: 'card', cardId: wrong.id });
    expect(pipeline(c).seal).toEqual({ call: null, why: 'Swap only with a deck card of the same family.' });
    c.api.cancel();
    c.api.drop(shelf.id, { kind: 'card', cardId: deck.id });
    const { seal } = pipeline(c);
    expect(seal.call).toEqual({ kind: 'swap', shelfId: shelf.id, deckId: deck.id });
    M.runSeal(c.api, seal.call!);
    const after = fire(c);
    expect([...after.lanes.claude, ...after.lanes.both, ...after.lanes.codex].map((k) => k.id)).toContain(shelf.id);
    expect(after.piles.shelf.map((k) => k.id)).toContain(deck.id);
  });
});
