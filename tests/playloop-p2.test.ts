// P2 integration: the engine gaps from P0 and the contract fields the four workers asked for, each on the synthetic
// sample through the real adapter and controller. Sealed protected text, the confirm-a-project chip, head tags on the
// glow, art keys, case refs in change previews, the boss skin, undone stamps after Undo, the allowance raise, and the
// controller's guards (self-drops, sealed drops, one owner for Enter at the fire, selection after boss.next).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInstruction, newDeck } from '../src/deck/deck';
import { conflicts, fuseSuggestions } from '../src/deck/campfire';
import { nodeRoot } from '../src/apply/node-root';
import type { Root } from '../src/apply/types';
import * as A from '../src/ui/playloop/adapter';
import { Controller, keyIntent } from '../src/ui/playloop/controller';
import type * as C from '../src/ui/playloop/contract';
import { TUTORIAL } from '../src/ui/sample';
import { SAMPLE_ROOT, sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let fresh: () => A.PlayState;
let label: (caseId: string) => string;
beforeAll(async () => {
  const an = await sampleAnalysis();
  fresh = () => A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true });
  label = (id) => an.labels.get(an.episodes.find((e) => e.id === id)!.sessionId)!;
});

const NOTES = 'Monorepo tooling lives under tools/. Ask before touching CI config.';

function judgeAndDeal(s: A.PlayState, stamp: 'issue' | 'pivot' = 'issue'): A.PlayState {
  for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, stamp);
  return A.actDeal(s);
}

/** Room 1 played on the beast, the event set aside: the first campfire. */
function toFirstFire(): A.PlayState {
  let s = judgeAndDeal(fresh());
  s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
  s = A.actAdvance(s);
  s = A.actStamp(s, A.selectRoom(s)!.heads[0]!.caseId, 'pivot');
  return A.actAdvance(s);
}

describe('sealed protected text (play-loop §7: the Notes block weighs and can be neither stacked nor burned)', () => {
  test('instructions become cards; other text stays protected', () => {
    const d = newDeck(sampleClaudeMd(), sampleAgentsMd());
    expect(d.imported.filter((c) => c.sealed).map((c) => c.text)).toEqual([NOTES]);
    expect(d.imported.filter((c) => !c.sealed).length).toBe(8);
    expect(isInstruction('When testing, run only the file you changed.')).toBe(true);
    expect(isInstruction('**Important**: never push to main')).toBe(true);
    expect(isInstruction('The repo uses TypeScript.')).toBe(false);
  });

  test('the sealed card never joins a gold or red thread, and every campfire change refuses it', () => {
    const s = toFirstFire();
    const fire = A.selectCampfire(s);
    const notes = fire.lanes.claude.find((c) => c.inspector.exact === NOTES)!;
    expect(notes).toMatchObject({ type: 'protected', sealed: true, art: null });
    expect(notes.face.title).toBe('Protected text');
    // It weighs what it takes in the file: the line as written, bytes ÷ 3.
    expect(notes.weight).toBe(Math.ceil((NOTES.length + 1) / 3));
    expect(fire.threads.some((t) => t.members.includes(notes.id))).toBe(false);
    expect(fuseSuggestions(s.deck).some((g) => g.members.includes(notes.id))).toBe(false);
    expect(conflicts(s.deck).some((c) => c.a === notes.id || c.b === notes.id)).toBe(false);
    expect(A.actCut(s, notes.id)).toBe(s);
    expect(A.selectChangePreview(s, { cutId: notes.id })!.refused).toBe(A.SEALED);
    const other = fire.lanes.claude.find((c) => !c.sealed)!;
    expect(A.selectDrag(s, notes.id, { kind: 'fire' }).refused).toBe(A.SEALED);
    expect(A.selectDrag(s, other.id, { kind: 'card', cardId: notes.id }).refused).toBe(A.SEALED);
    // The other lines read from the file are rule cards (a quill), not protected text.
    expect(fire.lanes.claude.filter((c) => !c.sealed).every((c) => c.type !== 'protected')).toBe(true);
  });

  test('the controller refuses a sealed drop and a self-drop with a notice, and proposes nothing', () => {
    const c = new Controller(toFirstFire(), null, { viewport: { w: 1440, h: 900 } });
    const fire = c.screen();
    if (fire.kind !== 'campfire') throw new Error('not at the fire');
    const notes = fire.view.lanes.claude.find((x) => x.sealed)!;
    const uv = fire.view.lanes.claude.find((x) => !x.sealed)!;
    c.api.drop(notes.id, { kind: 'fire' });
    expect(c.ui.notice).toBe(A.SEALED);
    expect(c.ui.pending).toBeNull();
    c.api.drop(uv.id, { kind: 'card', cardId: uv.id });
    expect(c.ui.notice).toBe('A card cannot stack on itself.');
    expect(c.ui.pending).toBeNull();
  });
});

describe('the confirm-a-project chip (check 4)', () => {
  test('room 1 spans two projects: confirm one while judging, the drafts carry its scope, the other heads say why', () => {
    let s = fresh();
    const v0 = A.selectRoom(s)!;
    expect(v0.scope.chip).toBe('all projects');
    expect(v0.scope.confirmable).toBe(true);
    expect(v0.scope.projects.map((p) => p.label).sort()).toEqual(['datalad', 'pyramid']);
    const pyramid = v0.scope.projects.find((p) => p.label === 'pyramid')!;
    s = A.actConfirmProject(s, v0.roomKey, pyramid.key);
    expect(A.selectRoom(s)!.scope).toMatchObject({ chip: 'pyramid', confirmed: pyramid });
    s = judgeAndDeal(s);
    const v = A.selectRoom(s)!;
    expect(v.scope.confirmable).toBe(false);
    expect(A.actConfirmProject(s, v.roomKey, null)).toBe(s);
    const card = v.hand[0]!;
    expect(card.scope).toBe('pyramid');
    const pv = A.selectDrag(s, card.id, { kind: 'beast' });
    const byLabel = new Map(pv.heads.map((h) => [h.tag.project, h]));
    expect(byLabel.get('pyramid')!.glow).toBe(true);
    expect(byLabel.get('datalad')).toMatchObject({ glow: false, word: 'datalad' });
    const { result } = A.actPlay(s, card.id, 'beast');
    expect(result.standing.length).toBe(1);
    // Back to all projects resets the chip (before dealing).
    const back = A.actConfirmProject(A.actConfirmProject(fresh(), v0.roomKey, pyramid.key), v0.roomKey, null);
    expect(A.selectRoom(back)!.scope.chip).toBe('all projects');
    expect(A.actConfirmProject(fresh(), v0.roomKey, 'no-such-project')).toEqual(fresh());
  });
});

describe('contract fields the workers asked for', () => {
  test('glows carry each head tag; cards carry an art key from their family', () => {
    const s = judgeAndDeal(fresh());
    const v = A.selectRoom(s)!;
    const pv = A.selectDrag(s, v.hand[0]!.id, { kind: 'beast' });
    expect(pv.heads.map((h) => [label(h.caseId), h.tag.agent, h.tag.date])).toEqual(v.heads.map((h) => [label(h.caseId), h.tag.agent, h.tag.date]));
    expect(v.hand[0]!.art).toBe('scope');
    expect(v.hand[0]!.sealed).toBe(false);
  });

  test('change previews name every case they list (agent, project, date)', () => {
    const s = toFirstFire();
    const fire = A.selectCampfire(s);
    const played = fire.lanes.both.find((c) => c.provenance !== 'From your file')!;
    const cut = A.selectChangePreview(s, { cutId: played.id })!;
    expect(cut.cases.opened.length).toBe(3);
    expect(cut.refs.map((r) => r.caseId).sort()).toEqual([...cut.cases.opened].sort());
    expect(cut.refs.every((r) => r.agent && r.date)).toBe(true);
  });

  test('the boss carries the run\'s largest family skin', () => {
    let s = toFirstFire();
    while (A.selectScreen(s).kind !== 'boss') {
      const sc = A.selectScreen(s);
      if (sc.kind === 'room' || sc.kind === 'event') s = A.actSkip(judgeAndDeal(s, sc.kind === 'event' ? 'pivot' : 'issue')).state;
      s = A.actAdvance(s);
    }
    expect(A.selectBoss(s).skin).toBe('suite-wyrm');
  });

  test('the allowance raise: steps above the allowance, only upward, printed per lane', () => {
    const s = fresh();
    const b = A.selectBooks(s)[0]!;
    expect(b.raiseSteps).toEqual([1400, 1600, 2000]);
    expect(A.actRaiseAllowance(s, 'claude', 1000)).toBe(s);
    expect(A.actRaiseAllowance(s, 'claude', 1400.5)).toBe(s);
    const r = A.actRaiseAllowance(s, 'claude', 1400);
    expect(A.selectBooks(r)[0]!.weight).toMatchObject({ allowance: 1400, raisedBy: 1400 });
    expect(A.selectBooks(r)[0]!.raiseSteps).toEqual([1600, 1800, 2200]);
    expect(A.selectBooks(r)[1]!.weight.raisedBy).toBeNull();
  });
});

describe('the controller after the workers\' asks', () => {
  const ctl = (s: A.PlayState) => new Controller(s, null, { viewport: { w: 1440, h: 900 } });

  test('arrow keys select through api.select, so the reading (drag preview) follows the selection', () => {
    const c = ctl(judgeAndDeal(fresh()));
    c.api.cancel();
    expect(c.ui.drag).toBeNull();
    c.key('ArrowRight');
    const v = c.screen();
    if (v.kind !== 'room') throw new Error('not a room');
    expect(c.ui.selected).toBe(v.view.hand[0]!.id);
    expect(c.ui.drag?.preview?.verb).toBe('play');
  });

  test('at the fire, Enter leaves only when no proposal is up', () => {
    const c = ctl(toFirstFire());
    const screen = c.screen();
    expect(keyIntent('Enter', false, screen, null)).toEqual({ kind: 'advance' });
    expect(keyIntent('Enter', false, screen, { kind: 'cut', cardId: 'x' })).toBeNull();
  });

  test('boss.next clears the selection', () => {
    let s = toFirstFire();
    while (A.selectScreen(s).kind !== 'boss') {
      const sc = A.selectScreen(s);
      if (sc.kind === 'room' || sc.kind === 'event') s = A.actSkip(judgeAndDeal(s, sc.kind === 'event' ? 'pivot' : 'issue')).state;
      s = A.actAdvance(s);
    }
    const c = ctl(s);
    const b = c.screen();
    if (b.kind !== 'boss') throw new Error('not the boss');
    c.api.boss.stamp(b.view.current!, 'issue');
    const g = (c.screen() as { view: { candidates: { cardId: string; glow: boolean }[] } }).view.candidates.find((x) => x.glow)!;
    c.api.select(g.cardId);
    expect(c.ui.selected).toBe(g.cardId);
    c.api.boss.next();
    expect(c.ui.selected).toBeNull();
  });
});

describe('Apply and Undo: the three stamps read undone after a successful Undo', () => {
  let tmp: string;
  let roots: Root[];
  const port = (): A.ApplyPort => ({ roots: () => roots, needs: () => ({ claude: false, codex: false, agents: false }), readSkill: async (root, rel) => (root === 'codex-legacy-skills' ? null : roots.find((r) => r.id === root)!.read(rel)), ensureWritable: async () => true, grant: async () => null });
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'errata-p2-'));
    await cp(join(SAMPLE_ROOT, 'home'), join(tmp, 'home'), { recursive: true });
    roots = [
      await nodeRoot('claude', join(tmp, 'home/.claude')),
      await nodeRoot('codex', join(tmp, 'home/.codex')),
      await nodeRoot('claude-skills', join(tmp, 'home/.claude/skills')),
      await nodeRoot('codex-skills', join(tmp, 'home/.agents/skills')),
      await nodeRoot('backup', join(tmp, 'home/.claude')),
    ];
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('inked, then undone; the end summary prints a raise by you', async () => {
    let s = toFirstFire();
    const fire = A.selectCampfire(s);
    const red = fire.threads.find((t) => t.color === 'red')!;
    const full = fire.lanes.codex.find((c) => c.inspector.exact === TUTORIAL.redLink.onLine)!;
    s = A.actSettle(s, red.id, { kind: 'exception', on: full.id, text: TUTORIAL.redLink.text, when: {} });
    s = A.actRaiseAllowance(s, 'codex', 1400);
    while (A.selectScreen(s).kind !== 'apply') {
      const sc = A.selectScreen(s);
      if (sc.kind === 'room' || sc.kind === 'event') s = A.actSkip(judgeAndDeal(s, sc.kind === 'event' ? 'pivot' : 'issue')).state;
      if (sc.kind === 'boss') for (let i = 0; i < 4 && A.selectBoss(s).current; i++) s = A.actBossNext(A.selectBoss(s).turn === 'stamp' ? A.actBossStamp(s, A.selectBoss(s).current!, 'not-a-problem') : s);
      s = A.actAdvance(s);
    }
    s = await A.actPrepareApply(s, port());
    expect(A.selectApply(s, port()).summary.files.find((f) => f.lane === 'codex')!.raisedBy).toBe(1400);
    s = await A.actSeal(s, port());
    expect(A.selectApply(s, port()).stamps).toEqual({ reviewed: 'inked', fits: 'inked', written: 'inked' });
    s = await A.actUndo(s, port());
    expect(A.selectApply(s, port()).stamps).toEqual({ reviewed: 'undone', fits: 'undone', written: 'undone' });
  });
});

describe('the tutorial coach on the sample (§11, §0a.16): one line per gesture, gone when done', () => {
  test('room 1, the event, the first fire in order (uv spotlit first, then the exception merge, then the red pair), the boss', () => {
    const c = new Controller(fresh(), null, { viewport: { w: 1440, h: 900 } });
    const t = () => c.uiView().tutorial;
    expect(t()!.text).toContain('Instructions become cards; other text stays protected.');
    c.key('a');
    expect(t()!.text).toBe('Stamp each head from its own words: 2 still to stamp.');
    c.key('a');
    c.key('a');
    expect(t()!.text).toBe('Every head is stamped. Deal the hand.');
    c.key('Enter');
    const room = c.screen();
    if (room.kind !== 'room') throw new Error('not a room');
    expect(room.view.hand.length).toBe(1);
    expect(t()).toEqual({ text: 'One response fits what the logs show. Drag the card onto the beast: it adds to your proposed files for every agent whose head glows.', focus: { kind: 'card', cardId: room.view.hand[0]!.id } });
    c.key('Enter');
    expect(t()).toBeNull();
    c.key('Enter');
    expect(c.screen().kind).toBe('event');
    expect(t()!.text).toContain('A change of plan flies off');
    c.key('c');
    c.key('Enter');
    const fire = c.screen();
    if (fire.kind !== 'campfire') throw new Error('not at the fire');
    const uv = fire.view.threads.find((x) => x.color === 'gold' && x.members.length === 3)!;
    expect(t()!.focus).toEqual({ kind: 'thread', threadId: uv.id });
    expect(t()!.text).toContain(uv.reason);
    c.api.drop(uv.members[0]!, { kind: 'card', cardId: uv.members[1]! });
    expect(t()!.text).toContain('hold the seal or press Enter');
    c.api.campfire.fuse(uv.id, uv.autoText!);
    const fp = (c.screen() as { view: C.CampfireView }).view.threads.find((x) => x.color === 'gold')!;
    expect(t()).toEqual({ text: 'Exceptions survive a merge: stack the force-push pair and the longer line keeps its exception.', focus: { kind: 'thread', threadId: fp.id } });
    c.api.campfire.fuse(fp.id, fp.autoText!);
    const red = (c.screen() as { view: C.CampfireView }).view.threads.find((x) => x.color === 'red')!;
    expect(t()!.focus).toEqual({ kind: 'thread', threadId: red.id });
    const full = (c.screen() as { view: C.CampfireView }).view.lanes.codex.find((k) => k.inspector.exact === TUTORIAL.redLink.onLine)!;
    c.api.campfire.settle(red.id, { kind: 'exception', on: full.id, text: TUTORIAL.redLink.text, when: {} });
    expect(t()!.text).toBe('The fire is quiet. Leaving is free.');
  });

  test('real logs get no coach', () => {
    const c = new Controller({ ...fresh(), sample: false }, null, { viewport: { w: 1440, h: 900 } });
    expect(c.uiView().tutorial).toBeNull();
  });
});
