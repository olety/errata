// The second visit (spec §7): after a verified Apply, and only when the player says so, this browser keeps the Apply
// receipt (bundle id, files, checksums) and the stable ids of the lines it wrote. Nothing from a session log is kept:
// no quote, no command, no path inside a project. The engine's backups stay where Apply wrote them
// (~/.claude/.deck-backups/<bundle id>/), so Undo works on a later visit once the folders are granted again.

import type { Receipt } from '../apply/types';

export const REMEMBER_KEY = 'errata.apply.v1';

export interface RememberedApply {
  version: 1;
  /** When the player chose to keep it (ISO). */
  savedAt: string;
  bundleId: string;
  /** When Apply wrote (the receipt's timestamp). */
  writtenAt: string;
  /** The synthetic sample's Apply (written to this browser's private storage, not to your files). */
  sample: boolean;
  files: { root: string; rel: string; created: boolean; beforeSha: string | null; afterSha: string }[];
  /** The managed lines' stable ids per file: the `deck:<id>` markers Apply wrote. */
  lines: { file: 'CLAUDE.md' | 'AGENTS.md'; ids: string[] }[];
}

/** The part of Web Storage this needs (localStorage in the app, a map in tests). */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The record for a written receipt and the line ids now in each file. */
export function recordOf(r: Receipt, lines: RememberedApply['lines'], sample: boolean, now: Date = new Date()): RememberedApply {
  return {
    version: 1,
    savedAt: now.toISOString(),
    bundleId: r.bundleId,
    writtenAt: r.ts,
    sample,
    files: r.files.map((f) => ({ root: f.root, rel: f.rel, created: f.created, beforeSha: f.beforeSha, afterSha: f.afterSha })),
    lines: lines.map((l) => ({ file: l.file, ids: [...l.ids] })),
  };
}

const isStr = (x: unknown): x is string => typeof x === 'string';

/** The kept record, or null when there is none or it does not read as one (never throws). */
export function loadApply(store: Store | null): RememberedApply | null {
  try {
    const raw = store?.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<RememberedApply>;
    if (o.version !== 1 || !isStr(o.bundleId) || !isStr(o.writtenAt) || !isStr(o.savedAt) || !Array.isArray(o.files) || !Array.isArray(o.lines)) return null;
    if (!o.files.every((f) => f && isStr(f.rel) && isStr(f.root) && isStr(f.afterSha))) return null;
    if (!o.lines.every((l) => l && (l.file === 'CLAUDE.md' || l.file === 'AGENTS.md') && Array.isArray(l.ids) && l.ids.every(isStr))) return null;
    return o as RememberedApply;
  } catch {
    return null;
  }
}

/** Keep one record (a newer Apply replaces it). Returns false when the browser refuses storage. */
export function saveApply(store: Store | null, r: RememberedApply): boolean {
  try {
    if (!store) return false;
    store.setItem(REMEMBER_KEY, JSON.stringify(r));
    return true;
  } catch {
    return false;
  }
}

export function forgetApply(store: Store | null): void {
  try {
    store?.removeItem(REMEMBER_KEY);
  } catch {
    /* nothing kept */
  }
}

/** The browser's localStorage, or null when it is blocked (a private window, a sandbox). */
export function browserStore(): Store | null {
  try {
    const s = globalThis.localStorage;
    const k = `${REMEMBER_KEY}.probe`;
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

/** How many of a file's managed line ids came from the kept Apply (a second visit reads them back from the file). */
export function linesFromLastApply(r: RememberedApply | null, file: 'CLAUDE.md' | 'AGENTS.md', idsNow: readonly string[]): number {
  const kept = new Set(r?.lines.find((l) => l.file === file)?.ids ?? []);
  return idsNow.filter((id) => kept.has(id)).length;
}

// ------------------------------------------------------------------ the granted folders, kept with the receipt (browser)

/** A granted folder kept for a later Undo: the handle itself (IndexedDB stores it) and the identity Apply wrote with. */
export interface KeptGrant {
  handle: FileSystemDirectoryHandle;
  identity: string;
}

export type KeptGrants = Partial<Record<'claude' | 'codex' | 'agents', KeptGrant>>;

const DB = 'errata';
const GRANTS = 'grants';

function openDb(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(GRANTS);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
}

/** Keep the folder handles beside the receipt (one bundle at a time). Fails quietly where IndexedDB is blocked. */
export async function keepGrants(bundleId: string, g: KeptGrants): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((ok, no) => {
      const tx = db.transaction(GRANTS, 'readwrite');
      tx.objectStore(GRANTS).clear();
      tx.objectStore(GRANTS).put(g, bundleId);
      tx.oncomplete = () => ok();
      tx.onerror = () => no(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function keptGrants(bundleId: string): Promise<KeptGrants | null> {
  try {
    const db = await openDb();
    const v = await new Promise<KeptGrants | undefined>((ok, no) => {
      const req = db.transaction(GRANTS, 'readonly').objectStore(GRANTS).get(bundleId);
      req.onsuccess = () => ok(req.result as KeptGrants | undefined);
      req.onerror = () => no(req.error);
    });
    db.close();
    return v ?? null;
  } catch {
    return null;
  }
}

export async function forgetGrants(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((ok) => {
      const tx = db.transaction(GRANTS, 'readwrite');
      tx.objectStore(GRANTS).clear();
      tx.oncomplete = () => ok();
      tx.onerror = () => ok();
    });
    db.close();
  } catch {
    /* nothing kept */
  }
}
