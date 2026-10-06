// Parses session files off the main thread with a full incremental read. Per file it reports progress in bytes and
// sessions, runs the per-session detectors, then drops bulk tool output before posting the session back.
// Cancel stops between chunks; the sessions finished so far are returned and labelled as a cancelled run.
import { parseSessionFile } from '../parse/index';
import { compactSession, type Agent, type Session } from '../model';
import { detectEpisodes, type Episode } from '../episodes';

export type ParseRequest = { type: 'parse'; files: { rel: string; blob: Blob; agent?: Agent }[] } | { type: 'cancel' };

export type ParseReply =
  | { type: 'progress'; file: string; fileIndex: number; files: number; fileBytes: number; fileSize: number; bytesDone: number; bytesTotal: number; sessionsDone: number }
  | { type: 'done'; sessions: Session[]; episodes: Episode[]; failed: number; cancelled: boolean; ms: number; bytes: number };

let ac: AbortController | null = null;
const post = (m: ParseReply) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<ParseRequest>) => {
  if (ev.data.type === 'cancel') {
    ac?.abort();
    return;
  }
  const { files } = ev.data;
  ac = new AbortController();
  const signal = ac.signal;
  const t0 = performance.now();
  const bytesTotal = files.reduce((a, f) => a + f.blob.size, 0);
  const sessions: Session[] = [];
  const episodes: Episode[] = [];
  let failed = 0;
  let bytesBefore = 0;
  let last = 0;
  for (let i = 0; i < files.length && !signal.aborted; i++) {
    const f = files[i]!;
    const name = f.rel.split('/').pop() ?? f.rel;
    const report = (fileBytes: number, force = false) => {
      const now = performance.now();
      if (!force && now - last < 80) return;
      last = now;
      post({ type: 'progress', file: name, fileIndex: i + 1, files: files.length, fileBytes, fileSize: f.blob.size, bytesDone: bytesBefore + fileBytes, bytesTotal, sessionsDone: sessions.length });
    };
    report(0, true);
    try {
      const s = await parseSessionFile({ rel: f.rel, blob: f.blob }, f.agent, { signal, onBytes: (b) => report(b) });
      episodes.push(...detectEpisodes(s));
      sessions.push(compactSession(s));
    } catch (e) {
      if ((e as Error).name === 'AbortError') break;
      failed++;
    }
    bytesBefore += f.blob.size;
    report(f.blob.size, true);
  }
  post({ type: 'done', sessions, episodes, failed, cancelled: signal.aborted, ms: Math.round(performance.now() - t0), bytes: bytesBefore });
  ac = null;
};
