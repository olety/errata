// P4, the freeze leg: every budget label says budget (the book bar read as health to all five cold players), the card
// says what a play costs once when it brings the managed block header, the boss tally names the line not yet judged,
// and the page makes no network request of its own. Engine and adapter level, plus static sweeps over the source.
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDeck } from '../src/deck/deck';
import * as A from '../src/ui/playloop/adapter';
import type { BookView } from '../src/ui/playloop/contract';
import { BLOCK_HEADER_LONG, BUDGET, costText, FITS_WHY, fitsText, ghostText, overBudgetText, strapText } from '../src/ui/playloop/contract';
import { applyPlan, bossPlan, fitsMeaning, fitsWhy } from '../src/ui/playloop/end/model';
import { renderLanes } from '../src/deck/deck';
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

  test("the face's orb tooltip and aria-label carry the cost; the inspector explains the one-time marker lines", async () => {
    // Text-density pass: the footer is two chips; the once-only cost moved from the face's footer into the orb's
    // tooltip (and the card's aria-label), beside "+46 tok".
    const card = await Bun.file(join(ROOT, 'src/ui/playloop/cards/card.ts')).text();
    expect(card).toContain("tip(top.querySelector('.pl-cards-orb')!");
    expect(card).toContain('${c.cost ? ` · ${c.cost.text}` : \'\'}');
    expect(card).toContain('${c.cost ? ` ${c.cost.text}: the header\'s marker lines are paid once per file.` : \'\'}');
    const insp = await Bun.file(join(ROOT, 'src/ui/playloop/cards/inspector.ts')).text();
    expect(insp).toContain('...HeaderNote(c)');
    expect(insp).toContain('BLOCK_HEADER_LONG');
  });
});

/** From the first fire to the boss summary: settle red with Keep one, set every later head aside, skip the workshop. */
function toBossSummary(): A.PlayState {
  let s = judgeAndDeal(fresh());
  s = A.actPlay(s, A.selectRoom(s)!.hand[0]!.id, 'beast').state;
  for (let i = 0; i < 40; i++) {
    const sc = A.selectScreen(s);
    if (sc.kind === 'boss' && A.selectBoss(s).turn === 'summary') return s;
    if (sc.kind === 'campfire') {
      const red = sc.view.threads.find((t) => t.color === 'red');
      if (red) s = A.actSettle(s, red.id, { kind: 'keep', keep: red.newer! });
    }
    if (sc.kind === 'room' || sc.kind === 'event') {
      if (sc.view.kind === 'workshop') s = A.actSkip(s).state;
      else if (sc.view.phase === 'judge') for (const h of sc.view.heads) s = A.actStamp(s, h.caseId, 'not-a-problem');
    }
    if (sc.kind === 'boss') {
      for (let k = 0; k < 10 && A.selectBoss(s).current; k++) s = A.actBossNext(A.actBossStamp(s, A.selectBoss(s).current!, 'not-a-problem'));
      continue;
    }
    s = A.actAdvance(s);
  }
  throw new Error('never reached the boss summary');
}

describe('item 3: the boss tally names the line not yet judged', () => {
  test("the tally says \"1 line not yet judged: 'Report what you changed…'\" and links that line's card", () => {
    const s = toBossSummary();
    const b = A.selectBoss(s);
    const report = s.deck.imported.find((c) => c.text.startsWith('Report what you changed'))!;
    expect(b.score.unjudged).toEqual([{ cardId: report.id, excerpt: 'Report what you changed…' }]);
    expect(b.score.lines[2]).toContain("1 line not yet judged: 'Report what you changed…'");
    // The boss plan carries the links to the screen; the end screen's tally carries the same.
    expect(bossPlan(b).score.unjudged).toEqual(b.score.unjudged);
    expect(A.selectApply(s).summary.unjudged).toEqual(b.score.unjudged);
    expect(A.excerptOf('Use uv, not pip.')).toBe('Use uv, not pip.');
    expect(A.excerptOf('Never force-push, except to your own feature branch')).toBe('Never force-push, except to…');
  });

  test('the link opens its inspector row: Accept this reading / Does not apply, on the line as it is now', () => {
    const s = toBossSummary();
    const id = A.selectBoss(s).score.unjudged[0]!.cardId;
    const insp = A.selectInspector(s, { cardId: id });
    expect(insp?.kind).toBe('card');
    const card = insp!.kind === 'card' ? insp!.card : null;
    expect(card!.inspector.needsAcceptance).toBe(true);
    expect(card!.inspector.importJudgment).toBe('open');
  });

  test('Does not apply: the line is judged, the file is unchanged, the tally says so and the locked score asks to lock again', () => {
    const s0 = toBossSummary();
    const id = A.selectBoss(s0).score.unjudged[0]!.cardId;
    expect(A.selectBoss(s0).score.validity).toBe('locked');
    const s1 = A.actDeclineImport(s0, id);
    const lanes0 = renderLanes(s0.deck);
    const lanes1 = renderLanes(s1.deck);
    expect(Buffer.from(lanes1.claude.next).equals(Buffer.from(lanes0.claude.next))).toBe(true);
    expect(Buffer.from(lanes1.codex.next).equals(Buffer.from(lanes0.codex.next))).toBe(true);
    expect(A.selectBoss(s1).score.validity).toBe('stale');
    const s2 = A.actLockScore(s1);
    expect(A.selectBoss(s2).score.unjudged).toEqual([]);
    expect(A.selectBoss(s2).score.lines[2]).toContain('every line from your files is judged');
    const insp = A.selectInspector(s2, { cardId: id });
    expect(insp!.kind === 'card' && insp!.card.inspector.importJudgment).toBe('declined');
    // Changing your mind: Accept replaces the "does not apply" judgment.
    const s3 = A.actAcceptImport(s2, id);
    const after = A.selectInspector(s3, { cardId: id });
    expect(after!.kind === 'card' && after!.card.inspector.importJudgment).toBe('accepted');
    expect(s3.deck.declinedImports?.[id]).toBeUndefined();
  });

  test('a line with no suggested reading cannot be judged "does not apply"', () => {
    const s = fresh();
    const notes = s.deck.imported.find((c) => c.text.startsWith('Monorepo tooling'))!;
    expect(A.actDeclineImport(s, notes.id)).toBe(s);
  });

  test('the controller and the inspector offer Does not apply only while the line is open', async () => {
    const insp = await Bun.file(join(ROOT, 'src/ui/playloop/cards/inspector.ts')).text();
    expect(insp).toContain("judged === 'open' ? button('pl-cards-btn', 'Does not apply'");
    const ctl = await Bun.file(join(ROOT, 'src/ui/playloop/controller.ts')).text();
    expect(ctl).toContain('declineImport: (cardId) => this.commit(A.actDeclineImport(this.state, cardId)');
  });
});

describe('item 5: no request to any other site', () => {
  // A namespace is a name, not a request; the repo and Pages links may appear in text.
  const ALLOWED = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink', 'https://github.com/olety/errata', 'https://olety.github.io/errata/']);
  const urls = (text: string) => [...text.matchAll(/https?:\/\/[^\s"'`)<>%\\]+/g)].map((m) => m[0]);
  const foreign = (text: string) => urls(text).filter((u) => !ALLOWED.has(u));

  test('index.html links only the self-hosted fonts; no Google Fonts link or preconnect is left', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(foreign(html)).toEqual([]);
    expect(html).toContain('<link rel="stylesheet" href="/fonts/fonts.css" />');
    expect(html).not.toMatch(/googleapis|gstatic|preconnect/);
  });

  test('every font file is local woff2 with its OFL licence beside it, and SOURCES.md records where each came from', () => {
    const dir = join(ROOT, 'public/fonts');
    const css = readFileSync(join(dir, 'fonts.css'), 'utf8');
    expect(foreign(css)).toEqual([]);
    const files = [...css.matchAll(/url\('\.\/([^']+)'\)/g)].map((m) => m[1]!);
    const families = [...new Set([...css.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1]!))].sort();
    expect(families).toEqual(['JetBrains Mono', 'Lora', 'Shippori Mincho B1', 'Zen Kaku Gothic New']);
    const sources = readFileSync(join(dir, 'SOURCES.md'), 'utf8');
    for (const f of new Set(files)) {
      expect(readFileSync(join(dir, f)).subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(sources).toContain(`\`${f}\``);
    }
    for (const fam of families) {
      const ofl = readFileSync(join(dir, `OFL-${fam.replace(/ /g, '-')}.txt`), 'utf8');
      expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
    }
    // The weights the stylesheets use are all present (no synthesised bold for the titles' 800 or the mono 600).
    for (const [fam, w] of [['Shippori Mincho B1', 500], ['Shippori Mincho B1', 600], ['Shippori Mincho B1', 800], ['Zen Kaku Gothic New', 400], ['Zen Kaku Gothic New', 500], ['Zen Kaku Gothic New', 700], ['JetBrains Mono', 400], ['JetBrains Mono', 600], ['Lora', 400]] as const) {
      expect(css).toMatch(new RegExp(`font-family: '${fam}';\\n  font-style: \\w+;\\n  font-weight: ${w};`));
    }
  });

  test('the built page: index.html, its CSS and its scripts name no other site', () => {
    const out = mkdtempSync(join(tmpdir(), 'errata-build-'));
    try {
      const r = Bun.spawnSync(['bunx', 'vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, env: { ...process.env, ERRATA_BASE: '/errata/' } });
      expect(r.exitCode).toBe(0);
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      expect(html).toContain('href="/errata/fonts/fonts.css"');
      const assets = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.css') || f.endsWith('.js'));
      expect(assets.some((f) => f.endsWith('.css'))).toBe(true);
      const hits = [html, ...assets.map((f) => readFileSync(join(out, 'assets', f), 'utf8')), readFileSync(join(out, 'fonts/fonts.css'), 'utf8')].flatMap(foreign);
      expect(hits).toEqual([]);
      expect(existsSync(join(out, 'fonts/OFL-Lora.txt'))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  test('the import page and the README say so in words', async () => {
    const main = await Bun.file(join(ROOT, 'src/ui/main.ts')).text();
    expect(main).toContain('The page makes no network request to any other site, before or after it loads');
    const readme = await Bun.file(join(ROOT, 'README.md')).text();
    expect(readme).toContain('no network request to any other site, before or after it loads');
  });
});

describe('item 6: the README', () => {
  test('the sections, the two datasets with licences and attribution, the checklist link, the built-for line; no em-dash', () => {
    const md = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(heads).toEqual(['Privacy', 'Run it yourself', 'How it works', 'Synthetic sample', 'Known limits', 'Licence']);
    for (const b of ['**The atom.**', '**The cover rule.**', '**What is written where.**', '**The backups folder.**', '**Undo.**']) expect(md).toContain(b);
    expect(md).toContain('public/sample/manifest.json');
    expect(md).toContain('`nvidia/SWE-Hero-openhands-trajectories`');
    expect(md).toContain('`SWE-bench/SWE-smith-trajectories`');
    expect(md).toMatch(/CC-BY-4\.0 \| 2 rows, from the MIT-licensed repositories Pylons\/pyramid and datalad\/datalad/);
    expect(md).toContain('Attribution: the sample\'s sourced tool content is adapted from "NVIDIA SWE-Hero OpenHands trajectories" by NVIDIA');
    expect(md).toContain('[docs/REAL-RUN-CHECKLIST.md](docs/REAL-RUN-CHECKLIST.md)');
    expect(existsSync(join(ROOT, 'docs/REAL-RUN-CHECKLIST.md'))).toBe(true);
    expect(md).toContain('Built for Hackyard Yard #4, 2026-10-05 → 10-09. MIT licence, see `LICENSE`.');
    for (const k of ['Chromium', 'Firefox and Safari', 'ChatGPT app', 'Token figures are estimates', 'does not test whether an agent follows']) expect(md).toContain(k);
    for (const cmd of ['bun install', 'bun run dev', 'bun test', 'bun run build']) expect(md).toContain(cmd);
    expect(md).not.toContain('\u2014');
  });
});

describe('item 7: the submission assets', () => {
  const png = (rel: string) => {
    const b = readFileSync(join(ROOT, rel));
    expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };

  test('the blurb fits 500 characters; the card is 1440 × 900 with a 2x copy; the demo script names every beat', () => {
    const blurb = readFileSync(join(ROOT, 'docs/submission/blurb.txt'), 'utf8').trimEnd();
    expect(blurb.length).toBeLessThanOrEqual(500);
    expect(blurb).toStartWith('Errata turns your Claude Code and Codex session logs into a card run.');
    expect(png('docs/submission/card-1440x900.png')).toEqual({ w: 1440, h: 900 });
    expect(png('docs/submission/card-1440x900@2x.png')).toEqual({ w: 2880, h: 1800 });
    expect(png('docs/submission/card-selected-1440x900.png')).toEqual({ w: 1440, h: 900 });
    const script = readFileSync(join(ROOT, 'docs/demo/SCRIPT.md'), 'utf8');
    for (const t of ['0:00–0:03', '0:03–0:08', '0:08–0:13', '0:13–0:19', '0:19–0:24', '0:24–0:28', '0:28–0:30']) expect(script).toContain(t);
    expect(script).not.toContain('\u2014');
  });
});
