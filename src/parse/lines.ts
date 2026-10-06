// Incremental JSONL line reading. Never holds a whole file; never JSON.parses a whole file.
// Oversized sessions are read as header line + a complete-line tail window (spec §1).

import { MAX_LINE_BYTES, OVERSIZED_SESSION_BYTES, TAIL_WINDOW_BYTES } from '../model';

export interface LineSink {
  line(text: string): void;
  /** A row above MAX_LINE_BYTES was skipped. */
  oversized(): void;
  /** The middle of the file was skipped (oversized-session tail rule). */
  gap?(): void;
}

/** Splits a byte stream into UTF-8 lines. Rows longer than maxLine are dropped and reported. */
export class LineSplitter {
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private dropping = false;
  private skipFirst: boolean;
  private decoder = new TextDecoder('utf-8');
  constructor(
    private sink: LineSink,
    opts: { skipFirstPartial?: boolean; maxLine?: number } = {},
  ) {
    this.skipFirst = opts.skipFirstPartial ?? false;
    this.maxLine = opts.maxLine ?? MAX_LINE_BYTES;
  }
  private maxLine: number;

  push(chunk: Uint8Array): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl === -1) {
        this.append(chunk.subarray(start));
        return;
      }
      this.append(chunk.subarray(start, nl));
      this.emit();
      start = nl + 1;
    }
  }

  /** Flush the last line (a file without a trailing newline). Returns true when a final partial row was emitted. */
  end(): boolean {
    if (this.partBytes > 0 || this.dropping) {
      this.emit();
      return true;
    }
    return false;
  }

  private append(b: Uint8Array): void {
    if (b.length === 0 || this.dropping) return;
    if (this.partBytes + b.length > this.maxLine) {
      this.dropping = true;
      this.parts = [];
      this.partBytes = 0;
      return;
    }
    this.parts.push(b.slice());
    this.partBytes += b.length;
  }

  private emit(): void {
    if (this.skipFirst) {
      this.skipFirst = false;
      this.reset();
      return;
    }
    if (this.dropping) {
      this.sink.oversized();
      this.reset();
      return;
    }
    if (this.partBytes === 0) {
      this.reset();
      return;
    }
    const buf = new Uint8Array(this.partBytes);
    let o = 0;
    for (const p of this.parts) {
      buf.set(p, o);
      o += p.length;
    }
    this.reset();
    let text = this.decoder.decode(buf);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim() !== '') this.sink.line(text);
  }

  private reset(): void {
    this.parts = [];
    this.partBytes = 0;
    this.dropping = false;
  }
}

/** Minimal Blob surface, satisfied by browser File/Blob and Bun's Blob/BunFile. */
export interface BlobLike {
  size: number;
  slice(start?: number, end?: number): BlobLike;
  stream(): ReadableStream<Uint8Array>;
}

async function pump(blob: BlobLike, splitter: LineSplitter, stopAfterFirstLine?: () => boolean): Promise<void> {
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      splitter.push(value);
      if (stopAfterFirstLine?.()) break;
    }
  } finally {
    reader.releaseLock?.();
  }
}

export interface ReadOutcome {
  /** 'tail-window' when the middle of the file was skipped. */
  window: 'full' | 'tail-window';
  /** The file did not end with a newline (possibly still being written or cut). */
  unterminated: boolean;
}

/** Feed every line of a session file into sink, applying the oversized-session tail rule. */
export async function readSessionLines(blob: BlobLike, sink: LineSink): Promise<ReadOutcome> {
  if (blob.size <= OVERSIZED_SESSION_BYTES) {
    const sp = new LineSplitter(sink);
    await pump(blob, sp);
    return { window: 'full', unterminated: sp.end() };
  }
  // Header: the first complete line (session_meta for Codex; first rows for Claude Code).
  let got = false;
  const headSink: LineSink = {
    line: (t) => {
      if (!got) {
        got = true;
        sink.line(t);
      }
    },
    oversized: () => {
      if (!got) {
        got = true;
        sink.oversized();
      }
    },
  };
  await pump(blob.slice(0, Math.min(blob.size, MAX_LINE_BYTES + 1)), new LineSplitter(headSink), () => got);
  // Tail: drop the first (partial) line of the window.
  sink.gap?.();
  const sp = new LineSplitter(sink, { skipFirstPartial: true });
  await pump(blob.slice(blob.size - TAIL_WINDOW_BYTES), sp);
  return { window: 'tail-window', unterminated: sp.end() };
}
