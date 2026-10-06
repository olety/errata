// Incremental JSONL line reading. Never holds a whole file; never JSON.parses a whole file.
// Every file is read in full, chunk by chunk; rows above MAX_LINE_BYTES are dropped and reported.

import { MAX_LINE_BYTES } from '../model';

export interface LineSink {
  line(text: string): void;
  /** A row above MAX_LINE_BYTES was skipped. */
  oversized(): void;
}

/** Splits a byte stream into UTF-8 lines. Rows longer than maxLine are dropped and reported. */
export class LineSplitter {
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private dropping = false;
  private decoder = new TextDecoder('utf-8');
  constructor(
    private sink: LineSink,
    opts: { maxLine?: number } = {},
  ) {
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

export interface ReadOptions {
  /** Aborts the read between chunks; the promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** Called after every chunk with the bytes read so far in this file. */
  onBytes?: (bytesRead: number) => void;
}

export interface ReadOutcome {
  /** The file did not end with a newline (possibly still being written or cut). */
  unterminated: boolean;
  bytesRead: number;
}

export function abortError(): Error {
  const e = new Error('The import was cancelled.');
  e.name = 'AbortError';
  return e;
}

/**
 * Feed every line of a session file into sink: a full, incremental read (no tail window).
 * Memory stays bounded by the row cap (MAX_LINE_BYTES) plus what the parser chooses to keep.
 */
export async function readSessionLines(blob: BlobLike, sink: LineSink, opts: ReadOptions = {}): Promise<ReadOutcome> {
  const sp = new LineSplitter(sink);
  const reader = blob.stream().getReader();
  let bytesRead = 0;
  try {
    for (;;) {
      if (opts.signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      sp.push(value);
      bytesRead += value.length;
      opts.onBytes?.(bytesRead);
    }
  } finally {
    if (opts.signal?.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock?.();
  }
  return { unterminated: sp.end(), bytesRead };
}
