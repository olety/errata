// The text-density pass (2026-10-09): on the built sample in headless Chrome, at rest on each screen, count the visible
// words outside the content the player reads as data (the receipt quote, the card sentences, a textarea, the diff
// bodies; tests/screens.ts says exactly what is left out). Units stay on screen (a number keeps its unit word), the
// sentences that explained them live behind the (i): the second half of this file opens a tooltip and a note and
// finds the words there.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { buildSite, CHROME, withPage } from './cdp';
import { COUNT_WORDS, toScreen, type ScreenKey } from './screens';

const have = !!CHROME;
let site = '';

beforeAll(async () => {
  if (have) site = await buildSite();
}, 120_000);
afterAll(() => {
  if (site) rmSync(site, { recursive: true, force: true });
});

/**
 * The caps. Import, campfire and Apply keep the mandate's numbers. Three are raised, each for the units and the
 * content the rules keep on screen:
 * - mirror 90: at the cap with the character card's one line (14 words: "6 of 7 stops drew a line · 5 of them cut off a
 *   full test run") and fifteen count tiles, each a number with its unit word ("12 sessions", "3 / 26 shell runs failed").
 * - room 95 (mandate 70): the receipt slip keeps its content (R9: the agent, project and date chips, "did exec: pytest
 *   → interrupted, no result", the four stamp words), both books keep "budget", "104 / 1,200 tok", the pending
 *   "+68 tok" and their Proposed watermark (R8), the card keeps "+46 tok", its title and "3 sessions" / "3 cases"
 *   (R10), the ghost row "→ CLAUDE.md · AGENTS.md · +46 tok each" (R10), the queue and head tags keep their dates.
 * - boss 90 (mandate 70): the six answer cards each keep their cost chip and type word ("+11 tok Your rule", R10),
 *   both books their budget units (R8), the slip its tag chips and the four stamp words (R9), and the tally its
 *   exact counts with units (R14).
 */
// mirror 145: the four how-to steps and the act's place names with one line each are the screen's point (owner
// 10-10: "make it grokkable"); the counts sit in the All counts note.
const CAP: Record<ScreenKey, number> = { import: 60, mirror: 145, room: 95, campfire: 90, boss: 90, apply: 120 };

describe('visible words at rest, per screen (1440 × 900)', () => {
  for (const s of Object.keys(CAP) as ScreenKey[]) {
    test.skipIf(!have)(
      `${s}: at most ${CAP[s]} words`,
      async () => {
        await withPage(site, { w: 1440, h: 900 }, async (p) => {
          await toScreen(p, s);
          const words = await p.eval<string[]>(COUNT_WORDS);
          expect({ screen: s, n: words.length, over: words.length > CAP[s] ? words.join(' ') : '' }).toEqual({ screen: s, n: words.length, over: '' });
          expect(p.errors()).toEqual([]);
        });
      },
      90_000,
    );
  }
});

describe('the words moved behind the (i) are one hover or one click away', () => {
  test.skipIf(!have)(
    "room 1 dealt: the coach's (i) shows the old line in the tooltip and the note; the seal chip names the held cases",
    async () => {
      await withPage(site, { w: 1440, h: 900 }, async (p) => {
        await toScreen(p, 'room');
        // The coach line is at most eight words; its (i) carries the full line it replaced.
        const coach = await p.eval<string>("document.querySelector('.pl-coach').textContent.trim()");
        expect(coach).toBe('Drag the card onto the beast.');
        await p.eval("document.querySelector('.pl-coach .ui-info').focus()");
        await p.until("document.querySelector('#ui-tip') && !document.querySelector('#ui-tip').hidden", 2000);
        expect(await p.eval<string>("document.querySelector('#ui-tip').textContent")).toContain('+46 tok · +22–23 once: the line, plus the marker lines a file gets with its first line.');
        await p.clickAt('.pl-coach .ui-info');
        await p.until("document.querySelector('.ui-note')", 2000);
        expect(await p.eval<string>("document.querySelector('.ui-note').textContent")).toContain('it adds to your proposed files for every agent whose head glows');
        await p.key('Escape');
        expect(await p.eval<boolean>("!document.querySelector('.ui-note')")).toBe(true);
        // The held-back chip: a wax seal and "2 held" on screen; the full words in its tooltip.
        expect(await p.eval<string>("document.querySelector('.pl-layout-sealed').getAttribute('data-tip')")).toBe('2 later cases, held for the boss');
        // The book: "budget" and the figure with its unit on the strap; what is left is in the tooltip.
        const fig = await p.eval<string>("document.querySelector('.pl-cards-book .pl-cards-book-fig').textContent");
        expect(fig).toContain('budget');
        expect(fig).toContain('104 / 1,200 tok');
        expect(await p.eval<string>("document.querySelector('.pl-cards-book .pl-cards-book-fig').getAttribute('data-tip')")).toContain('104 of 1,200 used · 1,096 left');
        // The card's footer: an eye with "3 sessions" and a target with "3 cases"; the sentences are tooltips.
        expect(await p.eval<string[]>("[...document.querySelectorAll('.pl-cards-hand .pl-cards-foot .ui-chip')].map((c) => c.getAttribute('data-tip'))")).toEqual(['seen in 3 sessions', 'answers 3 cases here']);
        // Right-click on a card opens its inspector (R3).
        await p.eval("document.querySelector('.pl-cards-hand .pl-cards-card').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))");
        await p.until("document.querySelector('.pl-cards-inspector')", 2000);
        expect(p.errors()).toEqual([]);
      });
    },
    90_000,
  );
});
