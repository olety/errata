// Parses session files off the main thread. Receives File/Blob objects with their relative paths,
// returns normalized, already-redacted Sessions.
import { parseSessionFile } from '../parse/index';
import type { Agent, Session } from '../model';

export interface ParseRequest {
  files: { rel: string; blob: Blob; agent?: Agent }[];
}
export type ParseReply = { type: 'progress'; done: number; total: number } | { type: 'done'; sessions: Session[]; failed: number };

self.onmessage = async (ev: MessageEvent<ParseRequest>) => {
  const { files } = ev.data;
  const out: Session[] = [];
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    try {
      out.push(await parseSessionFile({ rel: f.rel, blob: f.blob }, f.agent));
    } catch {
      failed++;
    }
    (self as unknown as Worker).postMessage({ type: 'progress', done: i + 1, total: files.length } satisfies ParseReply);
  }
  (self as unknown as Worker).postMessage({ type: 'done', sessions: out, failed } satisfies ParseReply);
};
