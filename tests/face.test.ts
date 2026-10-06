// Face copy (play-loop §10, §14.6): title ≤ 20, summary ≤ 64, the two-way guard, marked excerpts.
import { describe, expect, test } from 'bun:test';
import { compressLine, clampExcerpt, EXCERPT_MARK, FACE_TITLES, faceCopy, guardSummary, SUMMARY_MAX, TITLE_MAX, visibleLength } from '../src/deck/face';
import { draftCards } from '../src/deck/templates';
import { newDeck, presentCards } from '../src/deck/deck';
import { conflicts, resolveConflict } from '../src/deck/campfire';
import { setTaken } from '../src/deck/card';
import { buildRooms } from '../src/rooms';
import { detectEpisodes } from '../src/episodes';
import { TUTORIAL } from '../src/ui/sample';
import { allFixtures, sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

describe('face copy', () => {
  test('every title fits in 20 characters', () => {
    for (const t of Object.values(FACE_TITLES)) expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  test('every draft in the sample and the fixtures has a face that fits, and every template face passes the guard', async () => {
    const A = await sampleAnalysis();
    const fx = await allFixtures();
    const rooms = [...A.rooms, ...buildRooms(fx, fx.flatMap(detectEpisodes))];
    let n = 0;
    for (const r of rooms)
      for (const c of draftCards(r)) {
        const f = faceCopy(c);
        n++;
        expect(f.title.length).toBeLessThanOrEqual(TITLE_MAX);
        expect(visibleLength(f.summary)).toBeLessThanOrEqual(SUMMARY_MAX);
        if (f.mode === 'exact') expect(f.summary).toBe(c.text);
        if (f.mode === 'summary') expect(guardSummary(c.text, f.summary).ok).toBe(true);
        if (f.mode === 'excerpt') expect(f.mark).toBe(EXCERPT_MARK);
        expect(f.exact).toBe(c.text);
      }
    expect(n).toBeGreaterThan(10);
  });

  test("the sample's standing instruction reads as its guarded summary", async () => {
    const A = await sampleAnalysis();
    const r = A.rooms.find((x) => x.family === 'directive' && x.withheld.length > 0)!;
    const f = faceCopy(draftCards(r)[0]!);
    expect(f.mode).toBe('summary');
    expect(f.summary).toBe('Run only the changed test file; whole suite only on request.');
    expect(f.title).toBe('Standing instruction');
  });

  test('a line carrying an exception clause shows as a marked excerpt, never a summary that hides the clause', async () => {
    const A = await sampleAnalysis();
    const r = A.rooms.find((x) => x.family === 'directive' && x.withheld.length > 0)!;
    const d0 = newDeck(sampleClaudeMd(), sampleAgentsMd());
    const d = { ...d0, cards: [setTaken(draftCards(r)[0]!, true)] };
    const red = conflicts(d)[0]!;
    const full = presentCards(d).find((c) => c.text === TUTORIAL.redLink.onLine)!;
    const settled = resolveConflict(d, red, { kind: 'exception', on: full.id, text: TUTORIAL.redLink.text, when: {} });
    const line = presentCards(settled).find((c) => c.id === full.id)!;
    const f = faceCopy(line);
    expect(line.text).toContain('unless the user names a test file');
    expect(f.mode).toBe('excerpt');
    expect(f.mark).toBe(EXCERPT_MARK);
    expect(f.title).toBe('Your rule');
  });

  test('the guard catches a dropped negation, an added number, a dropped path and a dropped exception clause', () => {
    expect(guardSummary("Don't run the whole suite.", 'Run the whole suite.').missing).toContain("don't");
    expect(guardSummary('Stop after the build fails.', 'Stop after 2 failed builds.').added).toContain('2');
    expect(guardSummary('Never edit `pyramid/tests/` files.', 'Never edit the test files.').missing).toContain('pyramid/tests/');
    const g = guardSummary('Run the full suite before done, unless the user names a test file.', 'Run the full suite before done.');
    expect(g.ok).toBe(false);
    expect(g.missing.some((m) => m.startsWith('unless the user names a test file'))).toBe(true);
    expect(guardSummary('Never force-push to main.', 'Never force-push to main.').ok).toBe(true);
  });

  test('an excerpt closes an open code span and stays within the limit', () => {
    const x = clampExcerpt('When testing with `pytest tests/test_some_really_long_module_name.py`, run it alone and nothing else at all.');
    expect(visibleLength(x)).toBeLessThanOrEqual(SUMMARY_MAX);
    expect((x.match(/`/g) ?? []).length % 2).toBe(0);
    expect(x.endsWith('…')).toBe(true);
  });
});

describe('the guarded short form (P3, stall H: whole faces at M)', () => {
  test('drops the scope prefix and every clause with no guarded word; the guard still decides', () => {
    const exact = "In pyramid, never touch `pyramid/tests/`, it's frozen. Do it in `pyramid/config/` instead. Keep to this after any interruption, for the rest of the task.";
    const short = compressLine(exact)!;
    expect(short).toBe('Never touch `pyramid/tests/`. Do it in `pyramid/config/`.');
    expect(guardSummary(exact, short).ok).toBe(true);
    // A line whose every clause carries a guarded word has no short form.
    expect(compressLine('Never run `pytest` twice, not ever.')).toBeNull();
  });
});
