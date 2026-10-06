// The write protocol and guarded Undo. See ./types.ts for the full contract.

import type { ApplyResult, FileKind, JournalEntry, Manifest, ManifestEntry, Observed, Plan, PlannedFile, Receipt, Root, RootId, UndoFileResult, UndoResult } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b as BufferSource);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Relative path rules shared by every adapter. */
export function validateRel(rel: string): string | null {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || /^[A-Za-z]:/.test(rel)) return 'path must be relative';
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return 'path has an empty, "." or ".." segment';
  return null;
}

// Apply and Undo never run concurrently inside this app.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function rootMap(roots: Root[]): Map<RootId, Root> {
  return new Map(roots.map((r) => [r.id, r]));
}

async function planDigest(files: readonly PlannedFile[]): Promise<string> {
  const parts = files.map((f) => `${f.root}\u0000${f.rootIdentity}\u0000${f.rel}\u0000${f.kind}\u0000${f.baselineSha ?? 'absent'}\u0000${f.nextSha}`);
  return sha256(enc.encode(parts.join('\n')));
}

export interface Target {
  root: RootId;
  rel: string;
  kind: FileKind;
  next: Uint8Array;
}

/** Step 1. Read baselines and freeze private copies. Rejects duplicate targets. */
export async function makePlan(roots: Root[], targets: Target[]): Promise<Plan> {
  const rm = rootMap(roots);
  const seen = new Set<string>();
  const files: PlannedFile[] = [];
  for (const t of targets) {
    const root = rm.get(t.root);
    if (!root) throw new Error(`No access granted for ${t.root}.`);
    const bad = validateRel(t.rel);
    if (bad) throw new Error(`${t.rel}: ${bad}`);
    const key = `${root.identity}\u0000${t.rel.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`${t.rel} appears twice in one plan.`);
    seen.add(key);
    const baseline = await root.read(t.rel);
    const b = baseline ? baseline.slice() : null;
    // A guard's "next" is its baseline: it is only ever compared, never written.
    const n = t.kind === 'guard' ? (b ? b.slice() : new Uint8Array(0)) : t.next.slice();
    files.push(Object.freeze({ root: t.root, rootIdentity: root.identity, rel: t.rel, kind: t.kind, baseline: b, next: n, baselineSha: b ? await sha256(b) : null, nextSha: await sha256(n) }));
  }
  // Guards first (checked only), then Skill bodies, then the globals that point to them.
  const order = { guard: 0, skill: 1, global: 2 } as const;
  files.sort((a, b) => order[a.kind] - order[b.kind]);
  const frozen = Object.freeze(files);
  return Object.freeze({ createdAt: new Date().toISOString(), files: frozen, digest: await planDigest(frozen) });
}

async function observe(root: Root, rel: string, before: Uint8Array | null, after: Uint8Array): Promise<Observed> {
  try {
    const cur = await root.read(rel);
    if (cur === null) return before === null ? 'before' : 'absent';
    if (sameBytes(cur, after)) return 'after';
    if (sameBytes(cur, before)) return 'before';
    return 'other';
  } catch {
    return 'unreadable';
  }
}

function newBundleId(now: Date): string {
  const rnd = new Uint8Array(6);
  crypto.getRandomValues(rnd);
  return `${now.toISOString().replace(/[:.]/g, '-')}-${[...rnd].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

const BUNDLES = '.deck-backups';

/** Steps 2–6. `approvedDigest` is the digest of the plan the player saw in the diff. */
export function applyPlan(plan: Plan, roots: Root[], approvedDigest: string): Promise<ApplyResult> {
  return serial(async () => {
    const rm = rootMap(roots);
    const backup = rm.get('backup');
    if (!backup) return { status: 'rejected', reason: 'No folder granted for recovery bundles.' };
    if ((await planDigest(plan.files)) !== plan.digest || plan.digest !== approvedDigest) {
      return { status: 'rejected', reason: 'The plan changed after it was approved. Review the diff again.' };
    }
    for (const f of plan.files) {
      if ((f.baseline ? await sha256(f.baseline) : null) !== f.baselineSha || (await sha256(f.next)) !== f.nextSha) {
        return { status: 'rejected', reason: 'The plan changed after it was approved. Review the diff again.' };
      }
      const r = rm.get(f.root);
      if (!r || r.identity !== f.rootIdentity) return { status: 'rejected', reason: `${f.root} is not the folder the plan was made for.` };
    }
    // 2. recheck every target, no-ops included
    const changed: { root: RootId; rel: string }[] = [];
    for (const f of plan.files) {
      try {
        if (!sameBytes(await rm.get(f.root)!.read(f.rel), f.baseline)) changed.push({ root: f.root, rel: f.rel });
      } catch {
        changed.push({ root: f.root, rel: f.rel });
      }
    }
    if (changed.length) return { status: 'stale', changed };
    // 3. no-op filter
    const writes = plan.files.filter((f) => f.kind !== 'guard' && f.baselineSha !== f.nextSha);
    if (writes.length === 0) return { status: 'unchanged' };
    // 4. recovery bundle
    const now = new Date();
    const bundleId = newBundleId(now);
    const dir = `${BUNDLES}/${bundleId}`;
    try {
      if ((await backup.read(`${dir}/manifest.json`)) !== null) throw new Error('bundle id collision');
      const entries: ManifestEntry[] = [];
      for (const f of writes) {
        const r = rm.get(f.root)!;
        const beforePath = `${dir}/before/${f.root}/${f.rel}`;
        const afterPath = `${dir}/after/${f.root}/${f.rel}`;
        if (f.baseline) await writeVerified(backup, beforePath, f.baseline);
        await writeVerified(backup, afterPath, f.next);
        entries.push({
          root: f.root,
          rootIdentity: f.rootIdentity,
          rootLabel: r.label,
          rel: f.rel,
          kind: f.kind,
          before: f.baseline ? { absent: false, sha: f.baselineSha!, path: beforePath } : { absent: true },
          after: { sha: f.nextSha, path: afterPath },
        });
      }
      const manifest: Manifest = { version: 1, bundleId, createdAt: now.toISOString(), planDigest: plan.digest, entries };
      await writeVerified(backup, `${dir}/manifest.json`, enc.encode(JSON.stringify(manifest, null, 2) + '\n'));
    } catch (e) {
      return { status: 'backup-failed', error: String((e as Error).message ?? e) };
    }
    // 5. writes, guarded one by one
    const journal: JournalEntry[] = [];
    for (const f of writes) {
      const r = rm.get(f.root)!;
      let guard: Uint8Array | null;
      try {
        guard = await r.read(f.rel);
      } catch (e) {
        guard = new Uint8Array([0xff]); // unreadable counts as changed
      }
      if (!sameBytes(guard, f.baseline)) {
        if (journal.length === 0) return { status: 'stale', changed: [{ root: f.root, rel: f.rel }] };
        return { status: 'partial', bundleId, journal, failed: { root: f.root, rel: f.rel, error: 'changed by someone else just before writing' } };
      }
      try {
        await r.write(f.rel, f.next);
        const back = await r.read(f.rel);
        if (!sameBytes(back, f.next)) throw new Error('read-back differs from what was written');
        journal.push({ root: f.root, rel: f.rel, kind: f.kind, state: 'verified', observed: 'after' });
      } catch (e) {
        const err = String((e as Error).message ?? e);
        journal.push({ root: f.root, rel: f.rel, kind: f.kind, state: 'failed', observed: await observe(r, f.rel, f.baseline, f.next), error: err });
        return { status: 'partial', bundleId, journal, failed: { root: f.root, rel: f.rel, error: err } };
      }
    }
    // 6. final verification over the whole plan
    for (const f of plan.files) {
      const r = rm.get(f.root)!;
      const want = f.kind === 'guard' || f.baselineSha === f.nextSha ? f.baseline : f.next;
      let cur: Uint8Array | null;
      try {
        cur = await r.read(f.rel);
      } catch {
        cur = new Uint8Array([0xff]);
      }
      if (!sameBytes(cur, want)) {
        return { status: 'partial', bundleId, journal, failed: { root: f.root, rel: f.rel, error: 'changed after writing' } };
      }
    }
    const receipt: Receipt = {
      bundleId,
      ts: now.toISOString(),
      files: writes.map((f) => ({ root: f.root, rel: f.rel, kind: f.kind, created: f.baseline === null, beforeSha: f.baselineSha, afterSha: f.nextSha })),
    };
    return { status: 'written', receipt };
  });
}

async function writeVerified(root: Root, rel: string, bytes: Uint8Array): Promise<void> {
  if ((await root.read(rel)) !== null) throw new Error(`refusing to overwrite ${rel}`);
  await root.write(rel, bytes);
  const back = await root.read(rel);
  if (!sameBytes(back, bytes)) throw new Error(`read-back differs for ${rel}`);
}

export async function readManifest(backup: Root, bundleId: string): Promise<Manifest> {
  const raw = await backup.read(`${BUNDLES}/${bundleId}/manifest.json`);
  if (!raw) throw new Error('No recovery bundle with that id.');
  const m = JSON.parse(dec.decode(raw)) as Manifest;
  if (m.version !== 1 || m.bundleId !== bundleId || !Array.isArray(m.entries)) throw new Error('The recovery bundle manifest is not readable.');
  return m;
}

/**
 * Undo (or recovery after a partial run). Works from the bundle on disk. `only` restricts to a subset of targets.
 * Globals are restored before skills, so a pointer never outlives the skill it names.
 */
export function undoBundle(bundleId: string, roots: Root[], only?: { root: RootId; rel: string }[]): Promise<UndoResult> {
  return serial(async () => {
    const rm = rootMap(roots);
    const backup = rm.get('backup');
    if (!backup) return { status: 'refused', reason: 'No folder granted for recovery bundles.' };
    let m: Manifest;
    try {
      m = await readManifest(backup, bundleId);
    } catch (e) {
      return { status: 'refused', reason: String((e as Error).message ?? e) };
    }
    const entries = m.entries
      .filter((e) => !only || only.some((o) => o.root === e.root && o.rel === e.rel))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'global' ? -1 : 1));
    for (const e of entries) {
      const r = rm.get(e.root);
      if (!r || r.identity !== e.rootIdentity) return { status: 'refused', reason: `${e.rootLabel} is not the folder this bundle was made for.` };
    }
    const results: UndoFileResult[] = [];
    for (const e of entries) {
      const r = rm.get(e.root)!;
      try {
        const before = e.before.absent ? null : await backup.read(e.before.path);
        const after = await backup.read(e.after.path);
        if (!after || (await sha256(after)) !== e.after.sha) throw new Error('the bundle copy of the written file is damaged');
        if (!e.before.absent && (!before || (await sha256(before)) !== e.before.sha)) throw new Error('the bundle copy of the original is damaged');
        const cur = await r.read(e.rel);
        if (sameBytes(cur, before)) {
          results.push({ root: e.root, rel: e.rel, status: 'already-original' });
          continue;
        }
        if (!sameBytes(cur, after)) {
          results.push({ root: e.root, rel: e.rel, status: 'conflict', current: cur, original: before, currentSha: cur ? await sha256(cur) : null });
          continue;
        }
        if (before === null) await r.remove(e.rel);
        else await r.write(e.rel, before);
        const back = await r.read(e.rel);
        if (!sameBytes(back, before)) throw new Error('read-back after restore differs from the original');
        results.push({ root: e.root, rel: e.rel, status: 'restored' });
      } catch (err) {
        results.push({ root: e.root, rel: e.rel, status: 'failed', error: String((err as Error).message ?? err) });
      }
    }
    return { status: 'done', files: results };
  });
}

/**
 * After the player has seen a restore diff: put the original back, but only if the file still has the bytes
 * the player saw (currentSha from the conflict result).
 */
export function restoreOriginalSeen(bundleId: string, roots: Root[], target: { root: RootId; rel: string }, seenSha: string | null): Promise<UndoFileResult> {
  return serial(async () => {
    const rm = rootMap(roots);
    const backup = rm.get('backup');
    const r = rm.get(target.root);
    if (!backup || !r) return { ...target, status: 'failed', error: 'folder not granted' };
    try {
      const m = await readManifest(backup, bundleId);
      const e = m.entries.find((x) => x.root === target.root && x.rel === target.rel);
      if (!e || r.identity !== e.rootIdentity) return { ...target, status: 'failed', error: 'not in this bundle or a different folder' };
      const cur = await r.read(target.rel);
      if ((cur ? await sha256(cur) : null) !== seenSha) return { ...target, status: 'failed', error: 'the file changed again since the diff was shown' };
      const before = e.before.absent ? null : await backup.read(e.before.path);
      if (!e.before.absent && (!before || (await sha256(before)) !== e.before.sha)) return { ...target, status: 'failed', error: 'the bundle copy of the original is damaged' };
      if (before === null) await r.remove(target.rel);
      else await r.write(target.rel, before);
      if (!sameBytes(await r.read(target.rel), before)) return { ...target, status: 'failed', error: 'read-back after restore differs' };
      return { ...target, status: 'restored' };
    } catch (err) {
      return { ...target, status: 'failed', error: String((err as Error).message ?? err) };
    }
  });
}
