// node:fs adapter. Used by tests and the local scripts, never bundled into the app.

import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { Root, RootId } from './types';
import { validateRel } from './engine';

function within(base: string, p: string): boolean {
  return p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);
}

export async function nodeRoot(id: RootId, dir: string, label = dir): Promise<Root> {
  await mkdir(dir, { recursive: true });
  const base = await realpath(dir);

  async function resolve(rel: string, forWrite: boolean): Promise<string> {
    const bad = validateRel(rel);
    if (bad) throw new Error(`${rel}: ${bad}`);
    const p = join(base, ...rel.split('/'));
    const parent = dirname(p);
    if (forWrite) await mkdir(parent, { recursive: true });
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch {
      return p; // parent missing: nothing to escape through
    }
    if (!within(base, realParent)) throw new Error(`${rel}: resolves outside the granted folder`);
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        const target = await realpath(p);
        if (!within(base, target)) throw new Error(`${rel}: is a link outside the granted folder`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return p;
  }

  return {
    id,
    label,
    identity: `node:${base}`,
    async read(rel) {
      const p = await resolve(rel, false);
      try {
        return new Uint8Array(await readFile(p));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    async write(rel, bytes) {
      const p = await resolve(rel, true);
      await writeFile(p, bytes);
    },
    async remove(rel) {
      const p = await resolve(rel, false);
      await unlink(p);
    },
  };
}
