import { describe, expect, test } from 'bun:test';
import { ALLOWANCE, BEGIN, END, budgetFor, bytes, fitProblem, parseGlobal, renderGlobal, sanitizeLine, text, weigh } from '../src/deck/file';
import { buildLane, CLAUDE_LANE, codexLane, exportMap } from '../src/deck/lanes';
import { draftCards, groupRooms } from '../src/deck/templates';
import { setTaken, updateCard, acceptMapping, cardDigest } from '../src/deck/card';
import { detectEpisodes } from '../src/episodes';
import { CC, CX, fixture } from './helpers';

const line = (id: string, t: string) => ({ id, text: t, section: 'rules' as const });

describe('global file: managed block and protected text', () => {
  test('first insert appends one block and leaves every original byte in place', () => {
    const orig = bytes('# My rules\n\n- Keep answers short.\n');
    const next = renderGlobal(parseGlobal(orig), [line('r_1', 'Read the error first.')]);
    expect(text(next)).toBe(`# My rules\n\n- Keep answers short.\n\n${BEGIN}\n## Reviewed working rules\n- Read the error first. <!-- deck:r_1 -->\n${END}\n`);
    expect(next.subarray(0, orig.length)).toEqual(orig);
  });

  test('re-rendering replaces the block in place: no duplicate block, suffix kept byte-for-byte', () => {
    const orig = bytes(`top\n${BEGIN}\n## Reviewed working rules\n- old <!-- deck:r_1 -->\n${END}\nbottom with ünïcode\n`);
    const p = parseGlobal(orig);
    expect(p.managed).toEqual([line('r_1', 'old')]);
    const next = renderGlobal(p, [line('r_1', 'new'), line('r_2', 'second')]);
    expect(text(next).split(BEGIN).length).toBe(2);
    expect(text(next)).toStartWith('top\n');
    expect(text(next)).toEndWith(`${END}\nbottom with ünïcode\n`);
    expect(renderGlobal(parseGlobal(next), parseGlobal(next).managed)).toEqual(next);
  });

  test('CRLF files stay CRLF; a BOM and invalid UTF-8 outside the block survive byte-for-byte', () => {
    const prefix = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('rules\r\n'), 0xff, 0xfe, ...bytes('\r\n')]);
    const next = renderGlobal(parseGlobal(prefix), [line('r_1', 'x')]);
    expect(next.subarray(0, prefix.length)).toEqual(prefix);
    expect(text(next.subarray(prefix.length))).toBe(`\r\n${BEGIN}\r\n## Reviewed working rules\r\n- x <!-- deck:r_1 -->\r\n${END}\r\n`);
  });

  test('a file without a trailing newline gets a blank separator line', () => {
    const next = renderGlobal(parseGlobal(bytes('no newline')), [line('r_1', 'x')]);
    expect(text(next)).toStartWith(`no newline\n\n${BEGIN}\n`);
  });

  test('malformed markers block writing', () => {
    expect(parseGlobal(bytes(`a\n${BEGIN}\nno end\n`)).problem).not.toBeNull();
    expect(parseGlobal(bytes(`${BEGIN}\n${END}\n${BEGIN}\n${END}\n`)).problem).not.toBeNull();
    expect(() => renderGlobal(parseGlobal(bytes(`${END}\n`)), [])).toThrow();
  });

  test('card text cannot break out of its line or comment', () => {
    expect(sanitizeLine('a\nb --> <!-- c')).toBe('a b → c');
  });
});

describe('weight', () => {
  test('whole-file weight = UTF-8 bytes ÷ 3 by block, counting protected text', () => {
    const f = bytes(`${'x'.repeat(30)}\n${BEGIN}\n- a <!-- deck:r_1 -->\n${END}\n${'é'.repeat(5)}`);
    const w = weigh(f);
    const p = parseGlobal(f);
    expect(w.protectedBefore).toBe(Math.ceil(p.block!.start / 3));
    expect(w.protectedAfter).toBe(Math.ceil(10 / 3));
    expect(w.total).toBe(w.protectedBefore + w.managed + w.protectedAfter);
  });

  test('a file already over the allowance starts in no-growth mode at its own weight', () => {
    const big = bytes('y'.repeat(ALLOWANCE * 3 + 300));
    const b = budgetFor(big);
    expect(b.noGrowth).toBe(true);
    expect(b.allowance).toBe(weigh(big).total);
    const grown = renderGlobal(parseGlobal(big), [line('r_1', 'one more rule')]);
    expect(fitProblem(big, grown)).toContain('allowance');
    expect(fitProblem(big, grown, weigh(grown).total)).toBeNull();
  });
});

describe('lanes', () => {
  test('a card targeting both reaches both files; the export map is read from the rendered bytes', async () => {
    const all = await Promise.all([fixture(CC.repeated), fixture(CX.cli)]);
    const room = groupRooms(all.flatMap(detectEpisodes)).find((r) => r.family === 'repeated-command')!;
    const [a] = draftCards(room, { targets: 'both' });
    const taken = setTaken(a!, true);
    const cl = buildLane(CLAUDE_LANE, bytes('# Claude\n'), [taken]);
    const cx = buildLane(codexLane(null), bytes('# Codex\n'), [taken]);
    expect(text(cl.next)).toContain(taken.text);
    expect(text(cx.next)).toContain(taken.text);
    const ex = exportMap(cl.next, cx.next);
    expect(ex.claude.has(taken.id) && ex.codex.has(taken.id)).toBe(true);
    expect(cl.after.total).toBeGreaterThan(cl.before.total);
    expect(cl.problem).toBeNull();
  });

  test('a non-empty AGENTS.override.md becomes the Codex target', () => {
    expect(codexLane(bytes('override')).rel).toBe('AGENTS.override.md');
    expect(codexLane(bytes('  \n')).rel).toBe('AGENTS.md');
    expect(codexLane(null).rel).toBe('AGENTS.md');
  });
});

describe('cards', () => {
  test('any change to a coverage field changes the digest and the revision', async () => {
    const room = groupRooms(detectEpisodes(await fixture(CC.repeated)))[0]!;
    const [c] = draftCards(room);
    const accepted = acceptMapping(c!, 'case-1');
    expect(accepted.acceptedMappings['case-1']).toBe(cardDigest(c!));
    for (const patch of [{ text: 'other words' }, { targets: 'codex' as const }, { scope: { kind: 'project' as const, projectKey: 'p1', label: 'x' } }, { trigger: { event: 'command_failed' as const } }, { exceptions: [{ text: 'not in CI', when: { projectKey: 'p2' } }] }]) {
      const u = updateCard(accepted, patch);
      expect(cardDigest(u)).not.toBe(accepted.acceptedMappings['case-1']);
      expect(u.textRevision).toBe(accepted.textRevision + 1);
    }
    expect(updateCard(accepted, { exceptions: [] }).exceptionsReviewed).toBe(false);
    expect(Object.isFrozen(accepted)).toBe(true);
  });

  test('three drafts differ in what the agent will do', async () => {
    const room = groupRooms(detectEpisodes(await fixture(CC.repeated)))[0]!;
    const cards = draftCards(room);
    expect(new Set(cards.map((c) => c.responseKey)).size).toBe(3);
    expect(new Set(cards.map((c) => c.id)).size).toBe(3);
    expect(cards[0]!.text).toBe('When `bun run build` fails, read its error output before running it again unchanged.');
  });
});
