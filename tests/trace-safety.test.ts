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

test('fixtures and src carry no owner names, home paths or 40-hex shas', () => {
  const hits: string[] = [];
  for (const f of [...files(join(ROOT, 'fixtures')), ...files(join(ROOT, 'src'))]) {
    const text = readFileSync(f, 'utf8');
    const lower = text.toLowerCase();
    for (const b of BANNED) if (lower.includes(b.toLowerCase())) hits.push(`${f.slice(ROOT.length)}: ${b}`);
    const sha = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/i.exec(text);
    if (sha) hits.push(`${f.slice(ROOT.length)}: 40-hex`);
  }
  expect(hits).toEqual([]);
});

test('.gitignore keeps backups, local traces and scratch out of the repo', () => {
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
  for (const want of ['.deck-backups/', '*.local.jsonl', 'scratch/']) expect(gi).toContain(want);
});
