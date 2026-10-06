import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, makePlan, readManifest, restoreOriginalSeen, sameBytes, undoBundle } from '../src/apply/engine';
import { nodeRoot } from '../src/apply/node-root';
import type { Root } from '../src/apply/types';
import { bytes } from '../src/deck/file';

let dir: string;
let roots: Root[];
const CLAUDE_MD = new Uint8Array([...bytes('# Mine\r\n- keep this\r\n'), 0xff, 0x00, ...bytes('tail')]);
const AGENTS_MD = bytes('# Codex rules\n\nNo trailing newline at the end');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deck-apply-'));
  await mkdir(join(dir, 'claude'));
  await mkdir(join(dir, 'codex'));
  await writeFile(join(dir, 'claude', 'CLAUDE.md'), CLAUDE_MD);
  await writeFile(join(dir, 'codex', 'AGENTS.md'), AGENTS_MD);
  roots = [
    await nodeRoot('claude', join(dir, 'claude')),
    await nodeRoot('codex', join(dir, 'codex')),
    await nodeRoot('claude-skills', join(dir, 'claude', 'skills')),
    await nodeRoot('backup', join(dir, 'claude')),
  ];
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const claudeNext = new Uint8Array([...CLAUDE_MD, ...bytes('\n\n<!-- deck:begin v1 -->\n- r <!-- deck:r_1 -->\n<!-- deck:end -->\n')]);
const codexNext = bytes('# Codex rules\n\nNo trailing newline at the end\n\n<!-- deck:begin v1 -->\n- r <!-- deck:r_1 -->\n<!-- deck:end -->\n');
const targets = () => [
  { root: 'claude' as const, rel: 'CLAUDE.md', kind: 'global' as const, next: claudeNext },
  { root: 'codex' as const, rel: 'AGENTS.md', kind: 'global' as const, next: codexNext },
];
const read = (p: string) => readFile(join(dir, p)).then((b) => new Uint8Array(b));

describe('apply → undo', () => {
  test('both lanes written, verified, then restored to the exact original bytes', async () => {
    const plan = await makePlan(roots, targets());
    const res = await applyPlan(plan, roots, plan.digest);
    expect(res.status).toBe('written');
    expect(sameBytes(await read('claude/CLAUDE.md'), claudeNext)).toBe(true);
    expect(sameBytes(await read('codex/AGENTS.md'), codexNext)).toBe(true);
    if (res.status !== 'written') return;
    const m = await readManifest(roots[3]!, res.receipt.bundleId);
    expect(m.entries.map((e) => e.rel).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    const u = await undoBundle(res.receipt.bundleId, roots);
    expect(u.status).toBe('done');
    if (u.status === 'done') expect(u.files.map((f) => f.status)).toEqual(['restored', 'restored']);
    expect(sameBytes(await read('claude/CLAUDE.md'), CLAUDE_MD)).toBe(true);
    expect(sameBytes(await read('codex/AGENTS.md'), AGENTS_MD)).toBe(true);
  });

  test('identical reapplication performs no write and creates no bundle', async () => {
    const p1 = await makePlan(roots, targets());
    await applyPlan(p1, roots, p1.digest);
    const before = await readdir(join(dir, 'claude', '.deck-backups'));
    const p2 = await makePlan(roots, targets());
    expect((await applyPlan(p2, roots, p2.digest)).status).toBe('unchanged');
    expect(await readdir(join(dir, 'claude', '.deck-backups'))).toEqual(before);
  });

  test('a stale baseline blocks Apply with no writes', async () => {
    const plan = await makePlan(roots, targets());
    await writeFile(join(dir, 'codex', 'AGENTS.md'), bytes('edited elsewhere'));
    const res = await applyPlan(plan, roots, plan.digest);
    expect(res).toEqual({ status: 'stale', changed: [{ root: 'codex', rel: 'AGENTS.md' }] });
    expect(sameBytes(await read('claude/CLAUDE.md'), CLAUDE_MD)).toBe(true);
  });

  test('a plan that differs from the approved digest is rejected', async () => {
    const plan = await makePlan(roots, targets());
    expect((await applyPlan(plan, roots, 'not-the-digest')).status).toBe('rejected');
    (plan.files[0]!.next as Uint8Array)[0] = 0x21; // mutate the bytes after approval
    expect((await applyPlan(plan, roots, plan.digest)).status).toBe('rejected');
    expect(sameBytes(await read('claude/CLAUDE.md'), CLAUDE_MD)).toBe(true);
  });

  test('partial failure stops, journals the changed files and restores just that subset', async () => {
    const plan = await makePlan(roots, targets());
    const failing: Root[] = roots.map((r) => (r.id === 'codex' ? { ...r, write: async () => { throw new Error('disk full'); } } : r));
    const res = await applyPlan(plan, failing, plan.digest);
    expect(res.status).toBe('partial');
    if (res.status !== 'partial') return;
    expect(res.failed).toMatchObject({ root: 'codex', rel: 'AGENTS.md', error: 'disk full' });
    expect(res.journal.map((j) => `${j.rel}:${j.state}:${j.observed}`)).toEqual(['CLAUDE.md:verified:after', 'AGENTS.md:failed:before']);
    const changed = res.journal.filter((j) => j.observed !== 'before');
    const u = await undoBundle(res.bundleId, roots, changed);
    expect(u.status).toBe('done');
    expect(sameBytes(await read('claude/CLAUDE.md'), CLAUDE_MD)).toBe(true);
    expect(sameBytes(await read('codex/AGENTS.md'), AGENTS_MD)).toBe(true);
  });

  test('a write that lands half its bytes is journaled as other and needs a seen-diff restore', async () => {
    const plan = await makePlan(roots, targets());
    const half: Root[] = roots.map((r) =>
      r.id === 'codex' ? { ...r, write: async (rel: string, b: Uint8Array) => { await writeFile(join(dir, 'codex', rel), b.subarray(0, 5)); throw new Error('cut'); } } : r,
    );
    const res = await applyPlan(plan, half, plan.digest);
    if (res.status !== 'partial') throw new Error('expected partial');
    expect(res.journal.at(-1)!.observed).toBe('other');
    const u = await undoBundle(res.bundleId, roots);
    if (u.status !== 'done') throw new Error('expected done');
    const conflict = u.files.find((f) => f.rel === 'AGENTS.md')!;
    expect(conflict.status).toBe('conflict');
    if (conflict.status !== 'conflict') return;
    const fixed = await restoreOriginalSeen(res.bundleId, roots, { root: 'codex', rel: 'AGENTS.md' }, conflict.currentSha);
    expect(fixed.status).toBe('restored');
    expect(sameBytes(await read('codex/AGENTS.md'), AGENTS_MD)).toBe(true);
  });

  test('undo never clobbers an external edit: it reports a restore diff instead', async () => {
    const plan = await makePlan(roots, targets());
    const res = await applyPlan(plan, roots, plan.digest);
    if (res.status !== 'written') throw new Error('expected written');
    const external = bytes('someone edited this after Apply');
    await writeFile(join(dir, 'codex', 'AGENTS.md'), external);
    const u = await undoBundle(res.receipt.bundleId, roots);
    if (u.status !== 'done') throw new Error('expected done');
    const cx = u.files.find((f) => f.rel === 'AGENTS.md')!;
    expect(cx.status).toBe('conflict');
    expect(sameBytes(await read('codex/AGENTS.md'), external)).toBe(true);
    expect(u.files.find((f) => f.rel === 'CLAUDE.md')!.status).toBe('restored');
    // A stale "seen" sha is refused.
    expect((await restoreOriginalSeen(res.receipt.bundleId, roots, { root: 'codex', rel: 'AGENTS.md' }, 'stale')).status).toBe('failed');
  });

  test('undo refuses a different folder that has the same role', async () => {
    const plan = await makePlan(roots, targets());
    const res = await applyPlan(plan, roots, plan.digest);
    if (res.status !== 'written') throw new Error('expected written');
    await mkdir(join(dir, 'other'));
    const swapped = [...roots.filter((r) => r.id !== 'codex'), await nodeRoot('codex', join(dir, 'other'))];
    expect((await undoBundle(res.receipt.bundleId, swapped)).status).toBe('refused');
  });

  test('a Skill body is written before the global that points to it; undo deletes the created file', async () => {
    const skill = bytes('---\nname: verify-change\ndescription: Reviewed bug-fix workflow.\n---\n\n# Steps\n');
    const plan = await makePlan(roots, [...targets(), { root: 'claude-skills', rel: 'verify-change/SKILL.md', kind: 'skill', next: skill }]);
    expect(plan.files.map((f) => f.kind)).toEqual(['skill', 'global', 'global']);
    const order: string[] = [];
    const spy = roots.map((r) => ({ ...r, write: async (rel: string, b: Uint8Array) => { if (r.id !== 'backup') order.push(rel); return r.write(rel, b); } }));
    const res = await applyPlan(plan, spy, plan.digest);
    expect(res.status).toBe('written');
    expect(order).toEqual(['verify-change/SKILL.md', 'CLAUDE.md', 'AGENTS.md']);
    if (res.status !== 'written') return;
    await undoBundle(res.receipt.bundleId, roots);
    expect(await roots[2]!.read('verify-change/SKILL.md')).toBeNull();
  });

  test('duplicate targets, traversal and symlink escapes are rejected', async () => {
    await expect(makePlan(roots, [...targets(), targets()[0]!])).rejects.toThrow('twice');
    await expect(makePlan(roots, [{ root: 'claude', rel: '../escape.md', kind: 'global', next: bytes('x') }])).rejects.toThrow();
    await expect(makePlan(roots, [{ root: 'claude', rel: '/abs.md', kind: 'global', next: bytes('x') }])).rejects.toThrow();
    await mkdir(join(dir, 'outside'));
    await symlink(join(dir, 'outside'), join(dir, 'claude', 'link'));
    await expect(makePlan(roots, [{ root: 'claude', rel: 'link/x.md', kind: 'global', next: bytes('x') }])).rejects.toThrow('outside');
  });

  test('a guard file is checked but never written: absent stays absent', async () => {
    const plan = await makePlan(roots, [...targets(), { root: 'codex', rel: 'AGENTS.override.md', kind: 'guard', next: bytes('ignored') }]);
    expect(plan.files[0]!.kind).toBe('guard');
    const res = await applyPlan(plan, roots, plan.digest);
    expect(res.status).toBe('written');
    if (res.status === 'written') expect(res.receipt.files.map((f) => f.rel).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(await roots[1]!.read('AGENTS.override.md')).toBeNull();
  });

  test('an override that appears after the diff stops Apply with no writes', async () => {
    const plan = await makePlan(roots, [...targets(), { root: 'codex', rel: 'AGENTS.override.md', kind: 'guard', next: new Uint8Array(0) }]);
    await writeFile(join(dir, 'codex', 'AGENTS.override.md'), bytes('use these instead'));
    const res = await applyPlan(plan, roots, plan.digest);
    expect(res).toEqual({ status: 'stale', changed: [{ root: 'codex', rel: 'AGENTS.override.md' }] });
    expect(sameBytes(await read('claude/CLAUDE.md'), CLAUDE_MD)).toBe(true);
    expect(sameBytes(await read('codex/AGENTS.md'), AGENTS_MD)).toBe(true);
  });

  test('an override that appears during the writes means no Written receipt', async () => {
    const plan = await makePlan(roots, [...targets(), { root: 'codex', rel: 'AGENTS.override.md', kind: 'guard', next: new Uint8Array(0) }]);
    const sneaky: Root[] = roots.map((r) =>
      r.id === 'claude' ? { ...r, write: async (rel: string, b: Uint8Array) => { await r.write(rel, b); await writeFile(join(dir, 'codex', 'AGENTS.override.md'), bytes('x')); } } : r,
    );
    const res = await applyPlan(plan, sneaky, plan.digest);
    expect(res.status).toBe('partial');
    if (res.status === 'partial') expect(res.failed.rel).toBe('AGENTS.override.md');
  });

  test('bundles are unique and never overwritten', async () => {
    const p1 = await makePlan(roots, targets());
    const r1 = await applyPlan(p1, roots, p1.digest);
    if (r1.status !== 'written') throw new Error('expected written');
    await undoBundle(r1.receipt.bundleId, roots);
    const p2 = await makePlan(roots, targets());
    const r2 = await applyPlan(p2, roots, p2.digest);
    if (r2.status !== 'written') throw new Error('expected written');
    expect(r2.receipt.bundleId).not.toBe(r1.receipt.bundleId);
    expect((await readdir(join(dir, 'claude', '.deck-backups'))).length).toBe(2);
  });
});
