// The repo must never carry real traces. Fails if fixtures/ or src/ name the owner, his projects or a home path,
// or carry a 40-hex string that could be a real commit sha.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BANNED = ['olety', 'oneiron', 'eiri', 'antevon', 'Users/'];

const BINARY_EXT = /\.(png|webp|jpe?g|gif|avif|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm)$/i;

/** Image, font and media bytes are not text: their compressed data can spell anything ("eiri" once, inside a PNG). */
export function isBinary(path: string, bytes: Uint8Array): boolean {
  if (BINARY_EXT.test(path)) return true;
  const head = bytes.subarray(0, 8192);
  return head.includes(0);
}

/** Every text file under dir (binary files skipped by extension or a NUL byte in their first 8 KB). */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (!isBinary(p, readFileSync(p))) out.push(p);
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

test('binary files are skipped by extension or a NUL byte; text with the same bytes is still read', () => {
  expect(isBinary('public/playloop/beasts/heron/head.png', new TextEncoder().encode('eiri'))).toBe(true);
  expect(isBinary('notes/blob', new Uint8Array([0x65, 0x69, 0x72, 0x69, 0]))).toBe(true);
  expect(isBinary('src/x.ts', new TextEncoder().encode('const eiri = 1;'))).toBe(false);
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

/**
 * Test fakes must be caught by our redactor without looking like real tokens to secret scanners (GitHub push
 * protection flagged a Slack-shaped fake once). These are the common real shapes; no file in the repo may contain one.
 */
const REAL_TOKEN_SHAPES: [string, RegExp][] = [
  ['slack', /xox[abposr]-[0-9]{10,13}-/],
  ['github classic', /gh[pousr]_[A-Za-z0-9]{36}/],
  ['github fine-grained', /github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}/],
  ['aws access key id', /(?:AKIA|ASIA)[0-9A-Z]{16}/],
  ['google api key', /AIza[0-9A-Za-z_-]{35}/],
  ['openai-style key', /sk-[A-Za-z0-9]{20,}/],
];

test('no test fake, fixture or sample string has a real token shape', () => {
  const hits: string[] = [];
  for (const dir of ['tests', 'fixtures', 'src', 'public', 'scripts', 'bench']) {
    let list: string[] = [];
    try {
      list = files(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const f of list) {
      const text = readFileSync(f, 'utf8');
      for (const [name, re] of REAL_TOKEN_SHAPES) if (re.test(text)) hits.push(`${f.slice(ROOT.length)}: ${name}`);
    }
  }
  expect(hits).toEqual([]);
});
