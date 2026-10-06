// Apply / Undo (spec §9). One interface, two adapters: File System Access API (browser), node:fs (tests).
//
// Write protocol, in order. Any failure stops the run; nothing after the failing step happens.
//   1. plan:     read every target once → private copies of baseline bytes (null = absent) and next bytes,
//                plus a digest over target identities and both byte images. The diff is shown; the player
//                approves that digest. Any change to the plan needs a new approval.
//   2. recheck:  verify the digest and the granted roots; reread every target (no-op targets included) and
//                compare with its baseline byte-for-byte. Any change → 'stale', no writes.
//   3. no-op:    files whose next bytes equal the baseline leave the write list (they stay in final checks).
//                Nothing left → 'unchanged', no writes.
//   4. backup:   a new bundle .deck-backups/<unique id>/ (never an existing one): before/ and after/ payloads and
//                a versioned manifest. Every payload and the manifest are read back and compared. Any mismatch →
//                'backup-failed', no target writes.
//   5. write:    Skill bodies first, then the global files that point to them. Immediately before each write the
//                target is reread and compared with its baseline; after each write it is reread and compared with
//                next. Every attempted target is journaled with its observed state. A failure stops the run:
//                'stale' when nothing was written yet, else 'partial' with the journal.
//   6. verify:   reread every plan target once more (no-ops against baseline, writes against next).
//                All equal → 'written'. Otherwise 'partial'.
// Undo reads the bundle manifest from disk (works after a reload), checks the roots are the same directories,
// and per file: current == after → restore before (delete when before was absent) and read back;
// current == before → nothing to do; anything else → 'conflict' with both images for a restore diff.
// Remaining race, stated: a reread-then-write is not atomic. Another writer in the gap between the guard read and
// the write is not detectable by these adapters; runs inside this app are serialized.

export type RootId = 'claude' | 'codex' | 'claude-skills' | 'codex-skills' | 'backup';

/** A directory the player granted. Paths are relative, '/'-separated, validated by the adapter. */
export interface Root {
  id: RootId;
  /** Display label only (e.g. "~/.claude"). */
  label: string;
  /** Identity of the granted directory (Node: real path; browser: grant id). Undo refuses a different directory. */
  identity: string;
  /** null = absent. Throws when the file exists but cannot be read. */
  read(rel: string): Promise<Uint8Array | null>;
  write(rel: string, bytes: Uint8Array): Promise<void>;
  /** Remove a file this tool created. Never removes directories. */
  remove(rel: string): Promise<void>;
}

export type FileKind = 'skill' | 'global';

export interface PlannedFile {
  readonly root: RootId;
  readonly rootIdentity: string;
  readonly rel: string;
  readonly kind: FileKind;
  readonly baseline: Uint8Array | null;
  readonly next: Uint8Array;
  readonly baselineSha: string | null;
  readonly nextSha: string;
}

export interface Plan {
  readonly createdAt: string;
  readonly files: readonly PlannedFile[];
  /** Digest over target identities and both byte images. Apply requires the digest the player approved. */
  readonly digest: string;
}

export type Observed = 'after' | 'before' | 'absent' | 'other' | 'unreadable';

export interface JournalEntry {
  root: RootId;
  rel: string;
  kind: FileKind;
  state: 'verified' | 'failed';
  observed: Observed;
  error?: string;
}

export interface Receipt {
  bundleId: string;
  ts: string;
  files: { root: RootId; rel: string; kind: FileKind; created: boolean; beforeSha: string | null; afterSha: string }[];
}

export type ApplyResult =
  | { status: 'written'; receipt: Receipt }
  | { status: 'unchanged' }
  | { status: 'stale'; changed: { root: RootId; rel: string }[] }
  | { status: 'rejected'; reason: string }
  | { status: 'backup-failed'; error: string }
  | { status: 'partial'; bundleId: string; journal: JournalEntry[]; failed: { root: RootId; rel: string; error: string } };

export interface ManifestEntry {
  root: RootId;
  rootIdentity: string;
  rootLabel: string;
  rel: string;
  kind: FileKind;
  before: { absent: true } | { absent: false; sha: string; path: string };
  after: { sha: string; path: string };
}

export interface Manifest {
  version: 1;
  bundleId: string;
  createdAt: string;
  planDigest: string;
  entries: ManifestEntry[];
}

export type UndoFileResult =
  | { root: RootId; rel: string; status: 'restored' }
  | { root: RootId; rel: string; status: 'already-original' }
  | { root: RootId; rel: string; status: 'conflict'; current: Uint8Array | null; original: Uint8Array | null; currentSha: string | null }
  | { root: RootId; rel: string; status: 'failed'; error: string };

export type UndoResult = { status: 'done'; files: UndoFileResult[] } | { status: 'refused'; reason: string };
