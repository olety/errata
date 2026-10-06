// The repo must never carry real traces. Fails if fixtures/ or src/ name the owner, his projects or a home path,
// or carry a 40-hex string that could be a real commit sha.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BANNED = ['olety', 'oneiron', 'eiri', 'antevon', 'Users/'];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

/**
 * The synthetic sample's manifest records the public provenance it was built from: dataset revisions, upstream
 * instance commits and the pinned Codex source revision. Those public 40-hex values are allowed in that one file only.
 */
const PUBLIC_PROVENANCE = new Set([
  '150bc119e52c647216fce285fd801f16b6fd745b', // nvidia/SWE-Hero-openhands-trajectories revision
  '08e109b4a59eaeebf80e4675cd125d42e7ac99a4', // SWE-bench/SWE-smith-trajectories revision
  '88fcdc4e6a48f2646488565fbafd050f8e298ffa', // Pylons/pyramid instance commit (SWE-Hero row 18)
  'b3c3916449e13b8e3de4ecf4e0aee59b7fbc28f8', // datalad/datalad instance commit (SWE-Hero row 43)
  '588f616e8b6aee417d4b2f480e48b7e6d8741993', // openai/codex public source snapshot
]);

test('fixtures, src and the public sample carry no owner names, home paths or 40-hex shas', () => {
  const hits: string[] = [];
  for (const f of [...files(join(ROOT, 'fixtures')), ...files(join(ROOT, 'src')), ...files(join(ROOT, 'public'))]) {
    const text = readFileSync(f, 'utf8');
    const lower = text.toLowerCase();
    for (const b of BANNED) if (lower.includes(b.toLowerCase())) hits.push(`${f.slice(ROOT.length)}: ${b}`);
    const manifest = f.endsWith(join('public', 'sample', 'manifest.json'));
    for (const m of text.matchAll(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/gi)) {
      if (manifest && PUBLIC_PROVENANCE.has(m[0].toLowerCase())) continue;
      hits.push(`${f.slice(ROOT.length)}: 40-hex`);
    }
  }
  expect(hits).toEqual([]);
});

test('the public sample manifest carries no absolute local path', () => {
  const m = readFileSync(join(ROOT, 'public', 'sample', 'manifest.json'), 'utf8');
  expect(m).not.toMatch(/"\/(?:Users|home\/(?!sample\b))[^"]*"/);
  expect(JSON.parse(m).shape_validation.spike_report).toBe('spike-roots.md');
});

test('.gitignore keeps backups, local traces and scratch out of the repo', () => {
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
  for (const want of ['.deck-backups/', '*.local.jsonl', 'scratch/']) expect(gi).toContain(want);
});
