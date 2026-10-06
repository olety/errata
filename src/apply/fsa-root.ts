// File System Access API adapter (Chromium browsers). The player grants each folder with showDirectoryPicker.

import type { Root, RootId } from './types';
import { validateRel } from './engine';

type DirHandle = FileSystemDirectoryHandle;

async function walk(dir: DirHandle, segs: string[], create: boolean): Promise<DirHandle | null> {
  let d = dir;
  for (const s of segs) {
    try {
      d = await d.getDirectoryHandle(s, { create });
    } catch (e) {
      if ((e as DOMException).name === 'NotFoundError') return null;
      throw e;
    }
  }
  return d;
}

let grants = 0;

export function fsaRoot(id: RootId, handle: DirHandle, label: string, kept?: string): Root {
  // A grant id: Undo in the same tab refuses a different handle even when names match. A later visit passes the id it
  // kept beside the same handle (restored from this browser's storage, spec §7), so Undo finds the folder it wrote.
  const identity = kept ?? `fsa:${handle.name}:${Date.now().toString(36)}:${++grants}`;
  function split(rel: string): { dirs: string[]; name: string } {
    const bad = validateRel(rel);
    if (bad) throw new Error(`${rel}: ${bad}`);
    const parts = rel.split('/');
    return { dirs: parts.slice(0, -1), name: parts[parts.length - 1]! };
  }
  return {
    id,
    label,
    identity,
    async read(rel) {
      const { dirs, name } = split(rel);
      const d = await walk(handle, dirs, false);
      if (!d) return null;
      try {
        const fh = await d.getFileHandle(name);
        return new Uint8Array(await (await fh.getFile()).arrayBuffer());
      } catch (e) {
        if ((e as DOMException).name === 'NotFoundError') return null;
        throw e;
      }
    },
    async write(rel, bytes) {
      const { dirs, name } = split(rel);
      const d = await walk(handle, dirs, true);
      if (!d) throw new Error(`cannot create folders for ${rel}`);
      const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes as BufferSource);
      await w.close();
    },
    async remove(rel) {
      const { dirs, name } = split(rel);
      const d = await walk(handle, dirs, false);
      if (!d) return;
      await d.removeEntry(name);
    },
  };
}

/** Ask for readwrite permission on a handle (call from a click). */
export async function ensureWritable(handle: DirHandle): Promise<boolean> {
  const h = handle as DirHandle & { queryPermission?: (o: object) => Promise<string>; requestPermission?: (o: object) => Promise<string> };
  const opts = { mode: 'readwrite' };
  if ((await h.queryPermission?.(opts)) === 'granted') return true;
  return (await h.requestPermission?.(opts)) === 'granted';
}

/**
 * A root that lives under a prefix of another root (e.g. ~/.claude/skills inside the granted ~/.claude).
 * Paths are validated by the base root; the identity names the prefix so Undo refuses a different place.
 */
export function prefixedRoot(base: Root, id: RootId, prefix: string, label: string): Root {
  const p = prefix.replace(/\/+$/, '');
  return {
    id,
    label,
    identity: `${base.identity}/${p}`,
    read: (rel) => base.read(`${p}/${rel}`),
    write: (rel, bytes) => base.write(`${p}/${rel}`, bytes),
    remove: (rel) => base.remove(`${p}/${rel}`),
  };
}
