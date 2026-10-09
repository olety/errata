// End to end in Chrome for Testing, on the real built app (P3): the drop-files path with fixture sessions of both
// shapes, the export for a browser without folder access ("Exported, not applied", with its downloads), and the second
// visit's kept receipt on the import page. Fixtures only; the folder picker itself needs a person's click, so the
// owner's checklist (docs/REAL-RUN-CHECKLIST.md) covers it. Skips without Chrome for Testing.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite, CHROME, withPage, type Page } from './cdp';
import { CC, CX, FIX } from './helpers';

const have = CHROME !== null;
let site = '';

beforeAll(async () => {
  if (have) site = await buildSite();
}, 120_000);
afterAll(() => {
  if (site) rmSync(site, { recursive: true, force: true });
});

/** Two sessions, one of each shape: a Claude Code stop and a Codex Desktop stop (two boundary rooms, a fire, Apply). */
const FILES = [join(FIX, CC.directive), join(FIX, CX.desktop)];

const text = (sel: string) => `[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.trim())`;

async function dropToMirror(p: Page): Promise<void> {
  await p.goto('/');
  await p.until("document.querySelector('input.mt-file')");
  await p.files('input.mt-file', FILES);
  await p.until("[...document.querySelectorAll('h2')].some((h) => h.textContent === 'This run')");
  await p.click('Start the run');
  await p.until("document.querySelector('h1')?.textContent === 'What your sessions show'");
}

describe('end to end on the built app (Chrome for Testing)', () => {
  test.skipIf(!have)(
    'dropped session files of both shapes read through the worker into the mirror and the first room',
    async () => {
      await withPage(site, { w: 1440, h: 900 }, async (p) => {
        await p.goto('/');
        await p.until("document.querySelector('input.mt-file')");
        await p.files('input.mt-file', FILES);
        await p.until("[...document.querySelectorAll('h2')].some((h) => h.textContent === 'This run')");
        const run = await p.eval<string[]>(text('.mt-run tr'));
        expect(run).toContain('Claude Code sessions1');
        expect(run).toContain('Codex sessions1');
        await p.click('Start the run');
        await p.until("document.querySelector('h1')?.textContent === 'What your sessions show'");
        // The act's counts are tiles and the run's size is the receipt line, each with its definition on data-def; every
        // other count sits in the "All counts" note.
        const rows = await p.eval<string[]>("[...document.querySelectorAll('.mt-count, .mt-receipt-item')].map((e) => e.dataset.def)");
        expect(rows.find((r) => r.startsWith('Sessions'))).toStartWith('Sessions: 2 (Claude Code 1, Codex 1)');
        expect(await p.eval<string[]>(text('.mt-receipt-item .ui-chip-text'))).toContain('2 sessions');
        await p.eval("document.querySelector('.mt-receipt [aria-label=\"All counts\"]').click()");
        await p.until("document.querySelector('.ui-note')?.textContent.includes('Tool calls')");
        expect(await p.eval<string>("document.querySelector('.ui-note').textContent")).toContain('interrupted, no result');
        await p.key('Escape');
        // "Start the act" sits at the top of the mirror, under one line saying what the page is.
        const top = await p.eval<number>("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Start the act').getBoundingClientRect().top");
        expect(top).toBeLessThan(300);
        await p.click('Start the act');
        await p.until("document.querySelector('.pl-layout-table')");
        // The first room: a receipt with its stamps, the beast as a named target, no coach on real logs.
        expect(await p.eval<number>("document.querySelectorAll('.pl-room-stamp').length")).toBe(4);
        expect(await p.eval<boolean>("!!document.querySelector('[aria-label=\"The beast: play the selected card here\"]')")).toBe(true);
        expect(await p.eval<boolean>("!document.querySelector('.pl-coach')")).toBe(true);
        expect(p.errors()).toEqual([]);
      });
    },
    90_000,
  );

  test.skipIf(!have)(
    'without folder access Apply exports each block to paste, with a download, and writes nothing',
    async () => {
      await withPage(site, { w: 1440, h: 900 }, async (p) => {
        // A browser with no showDirectoryPicker (Firefox, Safari); downloads are caught, not saved.
        await p.before(`Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
          window.__downloads = [];
          const make = URL.createObjectURL.bind(URL);
          URL.createObjectURL = (b) => { const u = make(b); window.__downloads.push({ url: u, blob: b }); return u; };
          HTMLAnchorElement.prototype.click = function () { const d = window.__downloads.find((x) => x.url === this.href); if (d) d.name = this.download; };`);
        await p.goto('/');
        await p.until("document.querySelector('input.mt-file')");
        expect(await p.eval<number>("[...document.querySelectorAll('button')].filter((b) => b.textContent.startsWith('Choose')).length")).toBe(0);
        await dropToMirror(p);
        await p.click('Start the act');
        await p.until("document.querySelector('.pl-room-stamp')");
        // Room 1: a problem, deal, play on the beast (Enter plays the dealt card, its reading already on the page).
        await p.key('a');
        await p.key('Enter');
        await p.until("document.querySelector('.pl-cards-hand [role=button]')");
        await p.key('Enter');
        await p.until("[...document.querySelectorAll('button')].some((b) => b.textContent === 'Continue')");
        await p.key('Enter');
        // Room 2: not a problem, then Continue; the fire: leave; the final audit: on to Apply.
        await p.until("document.querySelector('.pl-room-stamp:not([disabled])')");
        await p.key('n');
        await p.key('Enter');
        for (let i = 0; i < 4 && !(await p.eval<boolean>("!!document.querySelector('.pl-end-exported')")); i++) {
          await Bun.sleep(300);
          await p.key('Enter');
        }
        await p.until("document.querySelector('.pl-end-exported')");
        expect(await p.eval<string>("document.querySelector('.pl-end-exported h3').textContent")).toBe('Exported, not applied');
        const blocks = await p.eval<string[]>(text('.pl-end-exportblock'));
        expect(blocks.length).toBeGreaterThan(0);
        expect(blocks.some((b) => b.startsWith('<!-- deck:begin v1 -->') && b.includes('<!-- deck:end -->'))).toBe(true);
        // No folder is asked for, and the seal stays shut.
        expect(await p.eval<number>("[...document.querySelectorAll('button')].filter((b) => b.textContent.startsWith('Choose ~/.')).length")).toBe(0);
        await p.click('Download');
        const got = await p.eval<{ name: string; text: string }[]>('Promise.all(window.__downloads.map(async (d) => ({ name: d.name, text: await d.blob.text() })))');
        expect(got.length).toBe(1);
        expect(got[0]!.name).toMatch(/^(CLAUDE|AGENTS)-errata-block\.md$/);
        expect(got[0]!.text.startsWith('<!-- deck:begin v1 -->')).toBe(true);
        expect(p.errors()).toEqual([]);
      });
    },
    120_000,
  );

  test.skipIf(!have)(
    'a kept receipt shows on the next visit with Undo and Forget; Undo without kept folders says so; Forget removes it',
    async () => {
      const rec = { version: 1, savedAt: '2026-10-07T04:01:00.000Z', bundleId: '20261007T040000Z-test', writtenAt: '2026-10-07T04:00:00.000Z', sample: false, files: [{ root: 'claude', rel: 'CLAUDE.md', created: false, beforeSha: 'a', afterSha: 'b' }, { root: 'codex', rel: 'AGENTS.md', created: false, beforeSha: 'c', afterSha: 'd' }], lines: [{ file: 'CLAUDE.md', ids: ['r_1', 'r_2'] }, { file: 'AGENTS.md', ids: ['r_1'] }] };
      await withPage(site, { w: 1440, h: 900 }, async (p) => {
        await p.before(`if (!sessionStorage.getItem('seeded')) { localStorage.setItem('errata.apply.v1', ${JSON.stringify(JSON.stringify(rec))}); sessionStorage.setItem('seeded', '1'); }`);
        await p.goto('/');
        await p.until("[...document.querySelectorAll('h2')].some((h) => h.textContent.startsWith('Your last Apply'))");
        const slip = await p.eval<string>("[...document.querySelectorAll('.mt-run')].find((e) => e.textContent.includes('Your last Apply')).textContent");
        expect(slip).toContain('CLAUDE.md and AGENTS.md, 3 lines with stable ids');
        expect(slip).toContain('.deck-backups/20261007T040000Z-test');
        await p.click('Undo it');
        await p.until("document.body.textContent.includes('were not kept in this browser')");
        await p.click('Forget it');
        await p.until("![...document.querySelectorAll('h2')].some((h) => h.textContent.startsWith('Your last Apply'))");
        expect(await p.eval<string | null>("localStorage.getItem('errata.apply.v1')")).toBeNull();
        expect(p.errors()).toEqual([]);
      });
    },
    90_000,
  );
});
