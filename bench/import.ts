// Dev-only: time the app's parse worker on files handed to the file input (one upload at a time accumulates).
// Prints counts and wall-clock only; no text from the files is shown.
import type { ParseReply, ParseRequest } from '../src/ui/worker';
import { analyse } from '../src/pipeline';

const files: File[] = [];
const input = document.getElementById('f') as HTMLInputElement;
const out = document.getElementById('out')!;
let w: Worker | null = null;
input.addEventListener('change', () => {
  for (const f of input.files ?? []) files.push(f);
  out.textContent = `${files.length} files, ${(files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(1)} MiB`;
  input.value = '';
});
// Optional: ?src=<local origin> fetches the files into memory first (fetch time is not part of the measurement).
const src = new URLSearchParams(location.search).get('src');
if (src) {
  const b = document.createElement('button');
  b.id = 'fetch';
  b.textContent = 'Fetch';
  document.querySelector('main')!.insertBefore(b, out);
  b.addEventListener('click', async () => {
    const list = (await (await fetch(`${src}/list`)).json()) as { i: number; name: string }[];
    for (const x of list) {
      const blob = await (await fetch(`${src}/f/${x.i}`)).blob();
      files.push(new File([blob], x.name));
      out.textContent = `${files.length} files fetched`;
    }
    out.textContent = `${files.length} files, ${(files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(1)} MiB`;
  });
}
document.getElementById('cancel')!.addEventListener('click', () => w?.postMessage({ type: 'cancel' } satisfies ParseRequest));
document.getElementById('run')!.addEventListener('click', () => {
  const t0 = performance.now();
  let progressEvents = 0;
  w = new Worker(new URL('../src/ui/worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<ParseReply>) => {
    if (ev.data.type === 'progress') {
      progressEvents++;
      out.textContent = `reading ${ev.data.fileIndex}/${ev.data.files} · ${(ev.data.bytesDone / 1048576).toFixed(0)} of ${(ev.data.bytesTotal / 1048576).toFixed(0)} MiB`;
      return;
    }
    const wall = performance.now() - t0;
    const t1 = performance.now();
    const a = analyse(ev.data.sessions, { episodes: ev.data.episodes });
    const analyseMs = performance.now() - t1;
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    out.textContent = JSON.stringify({
      files: files.length,
      mib: +(ev.data.bytes / 1048576).toFixed(1),
      workerMs: ev.data.ms,
      wallMs: Math.round(wall),
      analyseMs: Math.round(analyseMs),
      cancelled: ev.data.cancelled,
      failed: ev.data.failed,
      failures: ev.data.failures.map((f) => f.error),
      sessions: a.mirror.sessions,
      interventions: a.mirror.interventions,
      rooms: a.rooms.length,
      progressEvents,
      heapMiB: heap ? +(heap / 1048576).toFixed(0) : null,
    });
    w?.terminate();
  };
  w.postMessage({ type: 'parse', files: files.map((f) => ({ rel: f.name, blob: f })) } satisfies ParseRequest);
});
