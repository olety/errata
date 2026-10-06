import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRollout, ROLLOUT_BYTES } from '../scripts/gen-rollout';
import { allCalls, COMPACT_LIMITS, CUT_MARKER } from '../src/model';
import type { ParseReply } from '../src/ui/worker';

const MIB = 1_048_576;
const HEAP_LIMIT = 300 * MIB;
const SAMPLE_MS = 25;
type Done = Extract<ParseReply, { type: 'done' }>;
type MemorySample = { type: 'memory'; heapUsed: number; rss: number };

// Bun preloads this temporary sampler before the REAL worker entry point. App code is untouched.
// Sampling progress/done as well as the timer covers the boundaries of a fast or timer-starved parse.
const sampler = `
const post = globalThis.postMessage.bind(globalThis);
const sample = () => {
  const { heapUsed, rss } = process.memoryUsage();
  post({ type: 'memory', heapUsed, rss });
};
const timer = setInterval(sample, ${SAMPLE_MS});
globalThis.postMessage = (message, ...args) => {
  sample();
  if (message.type === 'done') clearInterval(timer);
  return post(message, ...args);
};
sample();
`;

test('a synthetic 54 MiB rollout stays below 300 MiB of heap through the parse worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errata-memory-'));
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const started = performance.now();
  try {
    const path = join(dir, 'rollout-synthetic.jsonl');
    const generated = await generateRollout(path);
    const blob = Bun.file(path);
    expect(blob.size).toBe(generated.bytes);
    expect(blob.size).toBeGreaterThanOrEqual(ROLLOUT_BYTES * 0.98);
    expect(blob.size).toBeLessThanOrEqual(ROLLOUT_BYTES * 1.02);
    const preload = join(dir, 'memory-sampler.js');
    await Bun.write(preload, sampler);
    let peakMainHeap = 0;
    let peakWorkerHeap = 0;
    let peakRss = 0;
    let mainSamples = 0;
    let workerSamples = 0;
    const sampleMain = () => {
      const { heapUsed, rss } = process.memoryUsage();
      peakMainHeap = Math.max(peakMainHeap, heapUsed);
      peakRss = Math.max(peakRss, rss);
      mainSamples++;
    };
    sampleMain();
    timer = setInterval(sampleMain, SAMPLE_MS);
    worker = new Worker(new URL('../src/ui/worker.ts', import.meta.url).href, {
      type: 'module', preload: [preload],
    });
    const done = await new Promise<Done>((resolve, reject) => {
      worker!.onerror = (event) => reject(new Error(event.message));
      worker!.onmessage = (event: MessageEvent<ParseReply | MemorySample>) => {
        const reply = event.data;
        if (reply.type === 'memory') {
          peakWorkerHeap = Math.max(peakWorkerHeap, reply.heapUsed);
          peakRss = Math.max(peakRss, reply.rss);
          workerSamples++;
        } else if (reply.type === 'done') {
          sampleMain();
          resolve(reply);
        }
      };
      worker!.postMessage({ type: 'parse', files: [{ rel: 'rollout-synthetic.jsonl', blob, agent: 'codex' }] });
    });
    sampleMain();
    clearInterval(timer);
    worker.terminate();
    // Independent peak sum is a conservative upper bound on the two heaps' concurrent sampled total.
    const peakHeap = peakMainHeap + peakWorkerHeap;
    const ms = Math.round(performance.now() - started);
    console.log(`MEMORY peak heapUsed=${(peakHeap / MIB).toFixed(2)} MB peak rss=${(peakRss / MIB).toFixed(2)} MB file=${(blob.size / MIB).toFixed(2)} MB ms=${ms}`);
    expect(mainSamples).toBeGreaterThan(1);
    expect(workerSamples).toBeGreaterThan(1);
    expect(peakWorkerHeap).toBeGreaterThan(0);
    expect(peakHeap).toBeLessThan(HEAP_LIMIT);
    expect(done.failed).toBe(0);
    expect(done.failures).toEqual([]);
    expect(done.cancelled).toBe(false);
    expect(done.bytes).toBe(blob.size);
    expect(done.sessions).toHaveLength(1);
    const session = done.sessions[0]!;
    expect(session.stats.lines).toBe(generated.lines);
    expect(session.stats.badLines).toBe(0);
    expect(session.stats.oversizedRows).toBe(0);
    expect(session.stats.orphanResults).toBe(0);
    expect(session.partial).toBe(false);
    expect(session.turns.filter((turn) => turn.role === 'human')).toHaveLength(generated.turns);
    expect(session.turns.some((turn) => turn.role === 'interrupt')).toBe(true);
    const calls = allCalls(session);
    expect(calls.every((call) => call.result !== null)).toBe(true);
    expect(calls.some((call) => call.result?.status === 'error')).toBe(true);
    expect(calls.some((call) => call.result?.status === 'interrupted')).toBe(true);
    expect(calls.some((call) => call.parentCallId !== null)).toBe(true);
    expect(calls.every((call) => call.result!.text.length <= COMPACT_LIMITS.result + CUT_MARKER.length)).toBe(true);
    expect(done.episodes.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(60_000);
  } finally {
    if (timer) clearInterval(timer);
    worker?.terminate();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
