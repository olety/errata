// The controller on the synthetic sample: the keyboard map, the room beats, tap–tap, refusals and campfire proposals.
import { beforeAll, describe, expect, test } from 'bun:test';
import { newDeck } from '../src/deck/deck';
import * as A from '../src/ui/playloop/adapter';
import { Controller, keyIntent } from '../src/ui/playloop/controller';
import { sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let fresh: () => Controller;
beforeAll(async () => {
  const an = await sampleAnalysis();
  fresh = () => new Controller(A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true }), null, { viewport: { w: 1440, h: 900 } });
});

describe('keyboard map (§3)', () => {
  test('judge keys stamp and walk; dealt keys pick, play, file, shelve and inspect; Escape cancels everywhere', () => {
    const c = fresh();
    const s = c.screen();
    expect(keyIntent('a', false, s)).toEqual({ kind: 'stamp', stamp: 'issue' });
    expect(keyIntent('C', false, s)).toEqual({ kind: 'stamp', stamp: 'pivot' });
    expect(keyIntent('n', false, s)).toEqual({ kind: 'stamp', stamp: 'not-a-problem' });
    expect(keyIntent('u', false, s)).toEqual({ kind: 'stamp', stamp: 'unclear' });
    expect(keyIntent('Tab', true, s)).toEqual({ kind: 'walk-heads', delta: -1 });
    expect(keyIntent('Enter', false, s)).toBeNull();
    expect(keyIntent('Escape', false, s)).toEqual({ kind: 'cancel' });
    for (let i = 0; i < 3; i++) c.key('a');
    expect(keyIntent('Enter', false, c.screen())).toEqual({ kind: 'deal' });
    c.key('Enter');
    const d = c.screen();
    expect(keyIntent('1', false, d)).toEqual({ kind: 'drop', target: { kind: 'book', lane: 'claude' } });
    expect(keyIntent('2', false, d)).toEqual({ kind: 'drop', target: { kind: 'book', lane: 'codex' } });
    expect(keyIntent('s', false, d)).toEqual({ kind: 'drop', target: { kind: 'shelf' } });
    expect(keyIntent('f', false, d)).toEqual({ kind: 'inspect' });
    expect(keyIntent(' ', false, d)).toEqual({ kind: 'inspect' });
    expect(keyIntent('ArrowRight', false, d)).toEqual({ kind: 'pick', delta: 1 });
    expect(keyIntent('Enter', false, d)).toEqual({ kind: 'drop', target: { kind: 'beast' } });
    expect(keyIntent('Backspace', false, d)).toEqual({ kind: 'pull-back' });
  });
});

describe('room beats and plays', () => {
  test('Rise → Judge → Deal → Play → Clear by keys alone; the next node starts at Rise', () => {
    const c = fresh();
    expect(c.ui.beat).toBe('rise');
    c.key('a');
    expect(c.ui.beat).toBe('judge');
    c.key('a');
    c.key('a');
    c.key('Enter');
    expect(c.ui.beat).toBe('deal');
    const first = (c.screen() as { view: { hand: { id: string }[] } }).view.hand[0]!.id;
    c.api.preview(first, { kind: 'beast' });
    expect(c.ui.beat).toBe('play');
    expect(c.uiView().drag!.preview!.heads.every((h) => h.glow)).toBe(true);
    c.key('Enter');
    expect(c.ui.beat).toBe('clear');
    const s = c.screen();
    expect(s.kind === 'room' && s.view.result!.bound.length).toBe(3);
    c.key('Enter');
    expect(c.screen().kind).toBe('event');
    expect(c.ui.beat).toBe('rise');
  });

  test('a hand card dropped on a head plays on the beast (§3)', () => {
    const c = fresh();
    for (let i = 0; i < 3; i++) c.key('a');
    c.key('Enter');
    const v = (c.screen() as { view: { hand: { id: string }[]; heads: { caseId: string }[] } }).view;
    expect(c.api.preview(v.hand[0]!.id, { kind: 'head', caseId: v.heads[1]!.caseId })!.verb).toBe('play');
    c.api.drop(v.hand[0]!.id, { kind: 'head', caseId: v.heads[1]!.caseId });
    const s = c.screen();
    expect(s.kind === 'room' && s.view.result!.bound.length).toBe(3);
  });

  test('a CLAUDE.md play leaves standing heads: Strike, then Clear', () => {
    const c = fresh();
    for (let i = 0; i < 3; i++) c.key('a');
    c.key('Enter');
    c.key('1');
    expect(c.ui.beat).toBe('strike');
    const s = c.screen();
    expect(s.kind === 'room' && s.view.result!.standing.length).toBe(2);
  });

  test('tap–tap plays the selected card on the tapped target; Escape clears the selection', () => {
    const c = fresh();
    for (let i = 0; i < 3; i++) c.key('a');
    c.key('Enter');
    const id = (c.screen() as { view: { hand: { id: string }[] } }).view.hand[0]!.id;
    c.api.select(id);
    expect(c.ui.selected).toBe(id);
    c.key('Escape');
    expect(c.ui.selected).toBeNull();
    c.api.select(id);
    c.api.tapTarget({ kind: 'book', lane: 'codex' });
    const s = c.screen();
    expect(s.kind === 'room' && s.view.result!.ink.map((x) => x.file)).toEqual(['AGENTS.md']);
  });

  test('a drop of a card that is not in the hand is refused with a notice and changes nothing', () => {
    const c = fresh();
    c.key('Tab');
    c.key('a');
    c.key('Enter');
    const before = c.state;
    // Dealt: only the standing instruction is in hand; play it, then try the shelf-only path via a forged id.
    c.api.drop('r_not_in_hand', { kind: 'beast' });
    expect(c.ui.notice).toBe('That card is not in this hand.');
    expect(c.state).toBe(before);
  });
});

describe('campfire proposals and the boss', () => {
  test('a stack proposes and the seal performs; a fire drop proposes a cut', () => {
    const c = fresh();
    for (let i = 0; i < 3; i++) c.key('a');
    c.key('Enter');
    c.key('Enter');
    c.key('Enter');
    c.key('c');
    c.key('Enter');
    const s = c.screen();
    expect(s.kind).toBe('campfire');
    if (s.kind !== 'campfire') return;
    const uv = s.view.threads.find((t) => t.color === 'gold' && t.members.length === 3)!;
    c.api.drop(uv.members[0]!, { kind: 'card', cardId: uv.members[1]! });
    expect(c.ui.pending).toEqual({ kind: 'stack', a: uv.members[0]!, b: uv.members[1]!, threadId: uv.id });
    const before = A.selectBooks(c.state)[0]!.weight.now;
    c.api.campfire.fuse(uv.id, uv.autoText!);
    expect(c.ui.pending).toBeNull();
    expect(A.selectBooks(c.state)[0]!.weight.now).toBeLessThan(before);
    c.api.drop(uv.members[0]!, { kind: 'fire' });
    expect(c.ui.pending).toEqual({ kind: 'cut', cardId: uv.members[0]! });
    c.key('Escape');
    expect(c.ui.pending).toBeNull();
  });
});
