// P4, the freeze leg: every budget label says budget (the book bar read as health to all five cold players), the card
// says what a play costs once when it brings the managed block header, the boss tally names the line not yet judged,
// and the page makes no network request of its own. Engine and adapter level, plus static sweeps over the source.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { newDeck } from '../src/deck/deck';
import * as A from '../src/ui/playloop/adapter';
import type { BookView } from '../src/ui/playloop/contract';
import { BLOCK_HEADER_LONG, BUDGET, costText, FITS_WHY, fitsText, ghostText, overBudgetText, strapText } from '../src/ui/playloop/contract';
import { applyPlan, fitsMeaning, fitsWhy } from '../src/ui/playloop/end/model';
import { sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

const ROOT = join(import.meta.dir, '..');
let an: Awaited<ReturnType<typeof sampleAnalysis>>;
let fresh: () => A.PlayState;

beforeAll(async () => {
  an = await sampleAnalysis();
  fresh = () => A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true });
});

function judgeAndDeal(s: A.PlayState, stamp: 'issue' | 'not-a-problem' = 'issue'): A.PlayState {
  for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, stamp);
  return A.actDeal(s);
}

/** From room 1 to the Workshop's dealt hand: play room 1's card, set every later head aside. */
function toWorkshopHand(): A.PlayState {
  let s = judgeAndDeal(fresh());
  s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
  for (let i = 0; i < 12 && !(A.selectScreen(s).kind === 'room' && A.selectRoom(s)!.kind === 'workshop'); i++) {
    const sc = A.selectScreen(s);
    if (sc.kind === 'room' || sc.kind === 'event') for (const h of sc.view.heads) s = A.actStamp(s, h.caseId, 'not-a-problem');
    s = A.actAdvance(s);
  }
  return A.actDeal(s);
}

const book = (file: 'CLAUDE.md' | 'AGENTS.md', now: number, allowance = 1200): BookView =>
  ({ lane: file === 'CLAUDE.md' ? 'claude' : 'codex', file, loaded: true, weight: { now, allowance, over: now > allowance, noGrowth: false, raisedBy: null } }) as unknown as BookView;

/** Every string literal in a source file, with ${…} expressions removed (copy only; identifiers are not copy). */
async function literals(rel: string): Promise<string[]> {
  const text = (await Bun.file(join(ROOT, rel)).text()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of text.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
    if (text[m.index! - 1] === '[') continue; // a type index such as BookView['weight']
    let lit = m[0];
    for (let i = 0; i < 4; i++) lit = lit.replace(/\$\{[^{}]*\}/g, '');
    out.push(lit);
  }
  return out;
}

describe('item 1: every label says token budget', () => {
  test('the strap: "token budget" on line one, "104 of 1,200 used · 1,096 left" on line two', () => {
    const claude = A.selectBooks(fresh()).find((b) => b.file === 'CLAUDE.md')!;
    expect(strapText(claude.weight.now, claude.weight.allowance)).toEqual({ title: 'token budget', used: '104 of 1,200 used · 1,096 left' });
    expect(BUDGET).toBe('token budget');
    expect(strapText(1230, 1200).used).toBe('1,230 of 1,200 used · over budget by 30');
  });

  test('the open clasp says "over budget by N"; a shut clasp has no over line', () => {
    expect(overBudgetText(1230, 1200)).toBe('over budget by 30');
    expect(overBudgetText(1200, 1200)).toBeNull();
  });

  test('the ghost while dragging says "+46 tok (+22 header, once)" per file', () => {
    const s = judgeAndDeal(fresh());
    const card = A.selectRoom(s)!.hand[0]!;
    const pv = A.selectDrag(s, card.id, { kind: 'beast' });
    expect(pv.ghost.claude.text).toBe('+46 tok (+22 header, once)');
    expect(pv.ghost.codex.text).toBe('+46 tok (+23 header, once)');
    expect(ghostText({ delta: 46, line: 46, blockHeader: 0, other: 0 })).toBe('+46 tok');
  });

  test('the end screen: "both files within budget" or "CLAUDE.md over budget by N"; Fits says "within the budget you chose"', () => {
    expect(fitsText([{ file: 'CLAUDE.md', now: 172, allowance: 1200 }, { file: 'AGENTS.md', now: 102, allowance: 1200 }])).toBe('both files within budget');
    expect(fitsText([{ file: 'CLAUDE.md', now: 1230, allowance: 1200 }, { file: 'AGENTS.md', now: 102, allowance: 1200 }])).toBe('CLAUDE.md over budget by 30');
    expect(fitsMeaning([book('CLAUDE.md', 1230), book('AGENTS.md', 102)])).toBe('CLAUDE.md over budget by 30');
    expect(fitsWhy([book('CLAUDE.md', 172), book('AGENTS.md', 102)])).toBe(`Fits: ${FITS_WHY} · CLAUDE.md 172 of 1,200 tokens · AGENTS.md 102 of 1,200 tokens (estimated)`);
    expect(FITS_WHY).toBe('within the budget you chose');
    // Through the adapter: the Apply view's Fits stamp on the sample after room 1's play.
    let s = judgeAndDeal(fresh());
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    const fits = applyPlan(A.selectApply(s)).stamps.find((x) => x.key === 'fits')!;
    expect(fits.meaning).toBe('both files within budget');
    expect(fits.why.startsWith('Fits: within the budget you chose · CLAUDE.md 172 of 1,200 tokens')).toBe(true);
  });

  test('a file over budget: the blocker and the Fits stamp name the file and the overage in budget words', () => {
    // A CLAUDE.md that arrives over the default budget may not grow (its budget is its own size): one play puts it over.
    const big = new Uint8Array([...sampleClaudeMd(), ...new TextEncoder().encode(`\n## Notes\n\n${'Keep this paragraph as it is. '.repeat(130)}\n`)]);
    let s = A.createPlayState({ analysis: an, deck: newDeck(big, sampleAgentsMd()), sample: true });
    s = judgeAndDeal(s);
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    const claude = A.selectBooks(s).find((b) => b.file === 'CLAUDE.md')!;
    expect(claude.weight.over).toBe(true);
    const over = claude.weight.now - claude.weight.allowance;
    const v = A.selectApply(s);
    const clasp = v.blockers.find((b) => b.kind === 'clasp')!;
    expect(clasp.text).toBe(`CLAUDE.md is over budget by ${over}: ${claude.weight.now.toLocaleString('en-US')} of ${claude.weight.allowance.toLocaleString('en-US')} tokens used (estimated).`);
    expect(applyPlan(v).stamps.find((x) => x.key === 'fits')!.meaning).toBe(`CLAUDE.md over budget by ${over}`);
  });

  test('no UI string says weight, weighs or allowance (the word "weight" may stay only in the inspector maths line)', async () => {
    const { Glob } = await import('bun');
    const word = /(?<![\w-])(weigh(?:s|t|ts|ed|ing)?|allowances?)(?![\w-])/i;
    const hits: string[] = [];
    for (const f of new Glob('src/ui/**/*.ts').scanSync({ cwd: ROOT })) for (const lit of await literals(f)) if (word.test(lit)) hits.push(`${f}: ${lit.slice(0, 70)}`);
    expect(hits).toEqual([]);
  });
});

describe('item 2: the header cost on the card', () => {
  test('room 1: the card that brings the block header says "+46 tok · +22–23 once" and names the marker lines', () => {
    const c = A.selectRoom(judgeAndDeal(fresh()))!.hand[0]!;
    expect(c.weight).toBe(46);
    expect(c.cost).toEqual({
      text: '+46 tok · +22–23 once',
      files: [
        { file: 'CLAUDE.md', line: 46, header: 22 },
        { file: 'AGENTS.md', line: 46, header: 23 },
      ],
      markers: ['<!-- deck:begin v1 -->', '## Reviewed working rules', '<!-- deck:end -->'],
    });
    // The face's figures add up to the strap's: line + header = the whole-file change per file.
    for (const f of c.cost!.files) {
      const g = c.playPreview!.ghost[f.file === 'CLAUDE.md' ? 'claude' : 'codex'];
      expect(f.line + f.header).toBe(g.delta);
    }
  });

  test('later cards in the same files bring no header and show no cost line', () => {
    let s = judgeAndDeal(fresh());
    s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
    s = A.actAdvance(s);
    s = A.actStamp(s, A.selectRoom(s)!.heads[0]!.caseId, 'issue');
    const v = A.selectRoom(A.actDeal(s))!;
    expect(v.hand.length).toBeGreaterThan(0);
    expect(v.hand.map((c) => c.cost)).toEqual(v.hand.map(() => null));
  });

  test('the first Skill card: "+33 tok · +7 once", and its one marker is the workflows heading', () => {
    const mint = A.selectRoom(toWorkshopHand())!.hand.find((c) => c.type === 'skill')!;
    expect(mint.cost!.text).toBe(`+${mint.weight} tok · +7 once`);
    expect(mint.cost!.markers).toEqual(['## Reusable workflows']);
  });

  test('costText: one figure when the files agree, a range when they differ by rounding, null with no header', () => {
    expect(costText(46, [22, 22])).toBe('+46 tok · +22 once');
    expect(costText(46, [22, 23])).toBe('+46 tok · +22–23 once');
    expect(costText(46, [])).toBeNull();
    expect(BLOCK_HEADER_LONG).toContain('paid once per file');
  });

  test('the face renders the cost on the footer and the inspector explains the one-time marker lines', async () => {
    const card = await Bun.file(join(ROOT, 'src/ui/playloop/cards/card.ts')).text();
    expect(card).toContain("el('span', 'pl-cards-cost'");
    const insp = await Bun.file(join(ROOT, 'src/ui/playloop/cards/inspector.ts')).text();
    expect(insp).toContain('...HeaderNote(c)');
    expect(insp).toContain('BLOCK_HEADER_LONG');
  });
});
