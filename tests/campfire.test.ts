// The campfire engine (spec §6): fuse suggestions and previews, exceptions preserved, red links and their four
// resolutions, cut with the coverage lost, sharpen re-requiring mapping approval. Plus Skill planning (spec §4, §9).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFuse, conflicts, cutCard, fuseSuggestions, preservedTokens, previewFuse, resolveConflict, sharpen } from '../src/deck/campfire';
import { deckExportMap, newDeck, presentCards, rebaseDeck, renderLanes, withCards } from '../src/deck/deck';
import { acceptMapping, cardDigest, setTaken } from '../src/deck/card';
import { bytes, text } from '../src/deck/file';
import type { Card, Case } from '../src/deck/types';
import { coverage } from '../src/cover';
import { suggestClaims } from '../src/deck/claims';
import { applyTargets } from '../src/deck/skill-plan';
import { applyPlan, makePlan, undoBundle } from '../src/apply/engine';
import { nodeRoot } from '../src/apply/node-root';
import type { Root } from '../src/apply/types';

const ids = (d: ReturnType<typeof newDeck>, re: RegExp) => presentCards(d).filter((c) => re.test(c.text)).map((c) => c.id).sort();

describe('fuse suggestions', () => {
  test('exact duplicates (case and punctuation folded) fuse into one line; the file loses a line', () => {
    const d = newDeck(bytes('# Rules\n\n- Keep commits small.\n- keep commits small\n'), null);
    const [s] = fuseSuggestions(d);
    expect(s).toMatchObject({ kind: 'exact' });
    const next = applyFuse(d, s!, s!.autoText!);
    expect(text(renderLanes(next).claude.next)).toBe('# Rules\n\n- Keep commits small.\n');
  });

  test('near duplicates at Jaccard ≥ 0.72; below it, nothing is suggested', () => {
    const near = newDeck(bytes('Run the linter before every commit.\nRun the linter before every single commit.\n'), null);
    expect(fuseSuggestions(near).length).toBe(1);
    const far = newDeck(bytes('Run the linter before every commit.\nWrite tests for new modules.\n'), null);
    expect(fuseSuggestions(far)).toEqual([]);
  });

  test('negation is never fused away: opposite claims are not duplicates', () => {
    const d = newDeck(bytes('Use npm for installs.\nDo not use npm for installs.\n'), null);
    expect(fuseSuggestions(d)).toEqual([]);
    expect(conflicts(d).length).toBe(1);
  });

  test('numbers and paths are protected words: the auto text keeps them or the player writes it', () => {
    expect([...preservedTokens('Keep functions under 40 lines in src/core.')].sort()).toEqual(['40', 'src/core']);
    const d = newDeck(bytes('Keep functions under 40 lines in src/core.\nKeep functions under 40 lines in src/core please.\n'), null);
    const [s] = fuseSuggestions(d);
    expect(s!.autoText).toBe('Keep functions under 40 lines in src/core.');
  });

  test('different scopes are declined; a game card with a different trigger is not fused', () => {
    const d0 = newDeck(bytes('Run the linter before every commit.\n'), null);
    const prose = presentCards(d0)[0]!;
    const scoped = Object.freeze({ ...prose, id: 'r_x', family: 'repeated-command', type: 'rule', source: undefined, scope: { kind: 'project', projectKey: 'p1', label: 'api' } }) as Card;
    expect(fuseSuggestions(withCards(d0, [setTaken(scoped, true)]))).toEqual([]);
  });

  test('a preview renders both files: before/after text, targets, exceptions, weights, cases', () => {
    const d = newDeck(bytes('Never force-push.\nNever force-push, except to your own branch after a rebase.\n'), bytes('Never force-push.\n'));
    const [s] = fuseSuggestions(d);
    expect(s!.members.length).toBe(3);
    const p = previewFuse(d, s!, s!.autoText!, []);
    expect(p.before.length).toBe(3);
    expect(p.after!.text).toContain('except to your own branch after a rebase');
    expect(p.after!.targets).toBe('both');
    expect(p.weight.claude.after).toBeLessThan(p.weight.claude.before);
    expect(p.weight.codex.after).toBeGreaterThan(p.weight.codex.before); // the exception now reaches Codex too
    expect(p.cases).toEqual({ before: 0, after: 0, confirmed: 0, opened: [], addressed: [] });
  });
});

describe('rebase', () => {
  test('loading AGENTS.md later keeps the CLAUDE.md edits, taken cards and resolved links', () => {
    const d0 = newDeck(bytes('- Keep commits small.\n- keep commits small\n'), null);
    const [s] = fuseSuggestions(d0);
    const d1 = applyFuse(d0, s!, s!.autoText!);
    const d2 = rebaseDeck(d1, d1.originals.claude, bytes('- Use uv.\n'), null);
    expect(text(renderLanes(d2).claude.next)).toBe(text(renderLanes(d1).claude.next));
    expect(presentCards(d2).map((c) => c.text)).toEqual(['Keep commits small.', 'Use uv.']);
  });
});

describe('conflicts', () => {
  // Both lines in one file: a Claude rule and a Codex rule never conflict with each other.
  const files = () => newDeck(bytes('- Run the full test suite before reporting done.\n- Only run the focused test file; never the full test suite.\n'), null);

  test('opposed actions under overlapping conditions are a red link', () => {
    const [c] = conflicts(files());
    expect(c!.claimA.object).toBe('tests:full');
    expect([c!.claimA.polarity, c!.claimB.polarity].sort()).toEqual(['do', 'dont']);
  });

  test('keep one: the other line is cut from its file', () => {
    const d = files();
    const [c] = conflicts(d);
    const next = resolveConflict(d, c!, { kind: 'keep', keep: c!.a });
    expect(conflicts(next)).toEqual([]);
    expect(presentCards(next).length).toBe(1);
  });

  test('write an explicit exception: visible text and a structured condition; the link goes when it separates', () => {
    const d = files();
    const [c] = conflicts(d);
    const next = resolveConflict(d, c!, { kind: 'exception', on: c!.a, text: 'unless the user names a test file', when: {} });
    const a = presentCards(next).find((x) => x.id === c!.a)!;
    expect(a.text).toBe('Run the full test suite before reporting done, unless the user names a test file.');
    expect(a.exceptions[0]!.text).toBe('unless the user names a test file');
    expect(conflicts(next)).toEqual([]);
  });

  test('cancel puts a card taken this run back on the shelf; prose alone stays red', () => {
    const d = files();
    expect(resolveConflict(d, conflicts(d)[0]!, { kind: 'cancel' })).toBe(d);
  });

  test('scopes that cannot meet do not conflict; targets that cannot meet do not conflict', () => {
    const d0 = newDeck(bytes('Run the full test suite before reporting done.\n'), null);
    const p = presentCards(d0)[0]!;
    const g = (over: Partial<Card>) => setTaken(Object.freeze({ ...p, id: 'r_y', family: 'directive', type: 'rule', source: undefined, text: 'Never run the full test suite.', claims: suggestClaims('Never run the full test suite.'), ...over }) as Card, true);
    expect(conflicts(withCards(d0, [g({ targets: 'codex' })]))).toEqual([]);
    expect(conflicts(withCards(d0, [g({ targets: 'both' })])).length).toBe(1);
  });
});

describe('cut and sharpen', () => {
  const card = (_d: ReturnType<typeof newDeck>): Card =>
    setTaken(
      Object.freeze({ id: 'r_z', type: 'rule', family: 'repeated-command', title: 'Read the error first', targets: 'claude', scope: { kind: 'global' }, trigger: { event: 'command_failed', commandPrefix: 'make' }, responseKey: 'inspect_error_before_retry', exceptions: [], exceptionsReviewed: true, text: 'When `make` fails, read its error first.', textRevision: 1, acceptedMappings: {}, evidenceRefs: [], taken: false, claims: [] }) as Card,
      true,
    );
  const kase: Case = { id: 'k1', agent: 'claude', projectKey: null, projectLabel: null, facts: { event: 'command_failed', fingerprint: 'make check' }, eligibleResponseKeys: ['inspect_error_before_retry'], disposition: 'issue', evidenceRefs: [] };

  test('cut shows the deletion and the coverage lost', () => {
    const d0 = newDeck(bytes('# Mine\n'), null);
    const c = acceptMapping(card(d0), 'k1');
    const d = withCards(d0, [c]);
    expect(coverage(presentCards(d), [kase], deckExportMap(d, renderLanes(d))).addressed).toBe(1);
    const { deck, coverageLost, preview } = cutCard(d, c.id, [kase]);
    expect(coverageLost).toEqual(['k1']);
    expect(preview.cases.before - preview.cases.after).toBe(1);
    expect(presentCards(deck).some((x) => x.id === c.id)).toBe(false);
  });

  test('sharpen changes the digest, so the mapping must be accepted again', () => {
    const d0 = newDeck(bytes('# Mine\n'), null);
    const c = acceptMapping(card(d0), 'k1');
    const d = sharpen(withCards(d0, [c]), c.id, 'When `make` fails, read the last error line first.');
    const s = presentCards(d).find((x) => x.id === c.id)!;
    expect(s.acceptedMappings.k1).not.toBe(cardDigest(s));
    expect(coverage(presentCards(d), [kase], deckExportMap(d, renderLanes(d))).addressed).toBe(0);
  });

  test('imported prose needs its suggested mapping accepted before it can cover anything', () => {
    const d = newDeck(bytes('- Report what you changed and the test result.\n'), null);
    const p = presentCards(d)[0]!;
    expect(p.responseKey).toBe('result_summary');
    expect(p.mappingSuggested).toBe(true);
  });
});

describe('skill planning', () => {
  let dir: string;
  let roots: Root[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deck-skill-'));
    await mkdir(join(dir, 'claude'));
    await mkdir(join(dir, 'codex'));
    await writeFile(join(dir, 'claude', 'CLAUDE.md'), '# Mine\n');
    await writeFile(join(dir, 'codex', 'AGENTS.md'), '# Codex\n');
    roots = [
      await nodeRoot('claude', join(dir, 'claude')),
      await nodeRoot('codex', join(dir, 'codex')),
      await nodeRoot('claude-skills', join(dir, 'claude', 'skills')),
      await nodeRoot('codex-skills', join(dir, 'agents', 'skills')),
      await nodeRoot('backup', join(dir, 'claude')),
    ];
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  const skillCard = (): Card =>
    setTaken(
      Object.freeze({ id: 's_t1', type: 'skill', family: 'workflow', title: 'Mint it', targets: 'both', scope: { kind: 'global' }, trigger: { event: 'workflow_completed', workflowKey: 'focused-test>diff-review>report' }, responseKey: 'mint_skill', exceptions: [], exceptionsReviewed: true, text: 'For the reviewed fix-and-verify workflow, use the `verify-change` skill.', textRevision: 1, acceptedMappings: {}, evidenceRefs: [], taken: false, claims: [], skillSlug: 'verify-change' }) as Card,
      true,
    );
  const read = (root: string, rel: string) => (root === 'codex-legacy-skills' ? Promise.resolve(null) : roots.find((r) => r.id === root)!.read(rel));

  test('a Codex skill lane that is off drops the Codex pointer; the Claude lane still gets body and pointer', async () => {
    const d = withCards(newDeck(bytes('# Mine\n'), bytes('# Codex\n')), [skillCard()]);
    const t = await applyTargets(d, [], { claude: true, codex: false }, read);
    expect(t.targets.filter((x) => x.kind === 'skill').map((x) => x.root)).toEqual(['claude-skills']);
    expect(text(t.lanes.claude.next)).toContain('`verify-change`');
    expect(text(t.lanes.codex.next)).not.toContain('verify-change');
    expect(t.notes.length).toBe(1);
  });

  test('a different skill with the same name is never overwritten', async () => {
    await mkdir(join(dir, 'claude', 'skills', 'verify-change'), { recursive: true });
    await writeFile(join(dir, 'claude', 'skills', 'verify-change', 'SKILL.md'), '---\nname: verify-change\ndescription: "someone else"\n---\nbody\n');
    const d = withCards(newDeck(bytes('# Mine\n'), bytes('# Codex\n')), [skillCard()]);
    const t = await applyTargets(d, [], { claude: true, codex: true }, read);
    expect(t.problems.some((p) => p.includes('A different skill named verify-change'))).toBe(true);
    expect(t.targets.some((x) => x.root === 'claude-skills')).toBe(false);
  });

  test('removing the pointer later never deletes the skill folder', async () => {
    const d = withCards(newDeck(bytes('# Mine\n'), bytes('# Codex\n')), [skillCard()]);
    const t = await applyTargets(d, [], { claude: true, codex: true }, read);
    const plan = await makePlan(roots, t.targets);
    expect((await applyPlan(plan, roots, plan.digest)).status).toBe('written');
    // Second visit: the pointer is a managed line now; cut it.
    const claudeNow = await roots[0]!.read('CLAUDE.md');
    const codexNow = await roots[1]!.read('AGENTS.md');
    const d2 = newDeck(claudeNow, codexNow);
    const pointer = presentCards(d2).find((c) => c.text.includes('verify-change'))!;
    const { deck } = cutCard(d2, pointer.id, []);
    const t2 = await applyTargets(deck, [], { claude: true, codex: true }, read);
    expect(t2.targets.some((x) => x.kind === 'skill')).toBe(false);
    const plan2 = await makePlan(roots, t2.targets);
    expect((await applyPlan(plan2, roots, plan2.digest)).status).toBe('written');
    expect(text((await roots[0]!.read('CLAUDE.md'))!)).not.toContain('verify-change');
    expect(await readdir(join(dir, 'claude', 'skills', 'verify-change'))).toEqual(['SKILL.md']);
    expect(await readdir(join(dir, 'agents', 'skills', 'verify-change'))).toEqual(['SKILL.md']);
    void undoBundle;
  });
});
