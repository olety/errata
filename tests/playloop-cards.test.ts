// The base layer (cards/layout): pure helpers, and the pixel check of every sample card face at M (§0a.20: validate
// faces by rendered pixels, not character counts). The pixel check renders the real Card component with the real web
// fonts in an isolated headless Chrome and fails on any overflow.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDeck } from '../src/deck/deck';
import * as A from '../src/ui/playloop/adapter';
import type { Bands, CardView, DragPreview, RoomView } from '../src/ui/playloop/contract';
import { COPY, footerText } from '../src/ui/playloop/contract';
import { signedDelta, strapGeom } from '../src/ui/playloop/cards/books';
import { CARD_BOX, faceText, footerParts } from '../src/ui/playloop/cards/card';
import { cardArt, fig, splitCode } from '../src/ui/playloop/cards/dom';
import { fanSlots, nextPair } from '../src/ui/playloop/cards/hand';
import { compareRows } from '../src/ui/playloop/cards/inspector';
import { placePlate, PLATES } from '../src/ui/playloop/layout/geom';
import { tableBoxes } from '../src/ui/playloop/layout/table';
import { layout } from '../src/ui/playloop/geometry';
import { sampleAgentsMd, sampleAnalysis, sampleClaudeMd } from './helpers';

let fresh: () => A.PlayState;
beforeAll(async () => {
  const an = await sampleAnalysis();
  fresh = () => A.createPlayState({ analysis: an, deck: newDeck(sampleClaudeMd(), sampleAgentsMd()), sample: true });
});

/** Every card face the sample run can show: each room's dealt hand and unavailable drafts, the deck and the shelf. */
function sampleCards(): { drafts: CardView[]; all: CardView[] } {
  const drafts = new Map<string, CardView>();
  const all = new Map<string, CardView>();
  for (const strategy of ['play', 'skip'] as const) {
    let s = fresh();
    for (let i = 0; i < 24; i++) {
      const sc = A.selectScreen(s);
      if (sc.kind === 'room' || sc.kind === 'event') {
        for (const h of sc.view.heads) s = A.actStamp(s, h.caseId, 'issue');
        s = A.actDeal(s);
        const v = A.selectRoom(s)!;
        for (const c of [...v.hand, ...v.unavailable]) drafts.set(`${c.id}:${c.footer?.text ?? ''}`, c);
        for (const c of v.deck) all.set(c.id, c);
        s = strategy === 'play' && v.hand.length ? A.actPlay(s, v.hand[0]!.id, 'beast').state : A.actSkip(s).state;
      } else if (sc.kind === 'campfire') {
        for (const c of Object.values(sc.view.lanes).flat()) all.set(c.id, c);
      }
      if (sc.kind === 'boss' || sc.kind === 'apply') break;
      s = A.actAdvance(s);
    }
    for (const c of A.selectPiles(s).shelf) all.set(c.id, c);
  }
  for (const c of drafts.values()) all.set(`${c.id}:${c.footer?.text ?? ''}`, c);
  // Astra's worst case for the footer and the orb: two-digit figures on the widest sample faces (a fixture, not data).
  const widest = [...drafts.values()].filter((c) => c.footer).slice(0, 3);
  for (const c of widest) {
    const stress: CardView = { ...c, id: `${c.id}-stress`, weight: 999, provenance: 'Repeated · 12', footer: { eligible: 12, newly: 12, text: footerText(12, 12) } };
    drafts.set(`${stress.id}:${stress.footer!.text}`, stress);
    all.set(`${stress.id}:${stress.footer!.text}`, stress);
  }
  return { drafts: [...drafts.values()], all: [...all.values()] };
}

describe('pure helpers', () => {
  test('inline code splits on backtick spans; an unmatched backtick stays text', () => {
    expect(splitCode('Read the error before rerunning `pytest`.')).toEqual([
      { code: false, text: 'Read the error before rerunning ' },
      { code: true, text: 'pytest' },
      { code: false, text: '.' },
    ]);
    expect(splitCode('a `b')).toEqual([{ code: false, text: 'a `b' }]);
    expect(splitCode('`x``y`')).toEqual([
      { code: true, text: 'x' },
      { code: true, text: 'y' },
    ]);
    expect(splitCode('<b>not html</b>')).toEqual([{ code: false, text: '<b>not html</b>' }]);
  });

  test('a face that does not fit becomes a marked excerpt of the exact line, never a silent clamp', () => {
    const card = { face: { title: 'T', summary: 'Short.', mode: 'summary' as const, mark: null }, inspector: { exact: 'The exact line as it lands.' } };
    expect(faceText(card, false)).toEqual({ text: 'Short.', mark: null, fallback: false });
    expect(faceText(card, true)).toEqual({ text: 'The exact line as it lands.', mark: COPY.excerpt, fallback: true });
    const ex = { face: { title: 'T', summary: 'Cut…', mode: 'excerpt' as const, mark: COPY.excerpt }, inspector: { exact: 'x' } };
    expect(faceText(ex, true)).toEqual({ text: 'Cut…', mark: COPY.excerpt, fallback: false });
  });

  test('the room footer stacks at its separator and keeps every figure of the view', () => {
    expect(footerParts('3 eligible here · 0 newly addressed')).toEqual(['3 eligible here', '0 newly addressed']);
    expect(footerParts('plain')).toEqual(['plain']);
  });

  test('figures format the view number only', () => {
    expect(fig(1200)).toBe('1,200');
    expect(fig(104)).toBe('104');
    expect(fig(-15)).toBe('−15');
  });

  test('card art is decoration keyed on the card itself; protected text gets the wax seal', () => {
    const base = { provenance: 'Observed', inspector: { trigger: null } };
    expect(cardArt({ ...base, type: 'skill' })).toBe('verify');
    expect(cardArt({ ...base, type: 'protected' })).toBeNull();
    expect(cardArt({ ...base, type: 'rule', inspector: { trigger: 'repeated command failure · pytest' } })).toBe('retry');
    expect(cardArt({ ...base, type: 'rule', provenance: 'Verified' })).toBe('verify');
    expect(cardArt({ ...base, type: 'rule' })).toBe('scope');
  });

  test('the three boxes are 5:7 at the sizes §10 names', () => {
    expect(CARD_BOX).toEqual({ S: { w: 148, h: 207 }, M: { w: 176, h: 246 }, L: { w: 208, h: 291 } });
  });

  test('the sample deals drafts with faces inside the engine caps', () => {
    const { drafts } = sampleCards();
    expect(drafts.length).toBeGreaterThan(10);
    for (const c of drafts) {
      expect(c.face.title.length).toBeLessThanOrEqual(20);
      if (c.face.mode === 'excerpt') expect(c.face.mark).toBe(COPY.excerpt);
    }
  });
});

describe('pure layout helpers', () => {
  test('the fan rotates only when the wood allows a rotated M; flat and carousel hands sit level', () => {
    expect(fanSlots(3, 'rotated')).toEqual([
      { rotate: -6, dy: 10 },
      { rotate: 0, dy: 0 },
      { rotate: 6, dy: 10 },
    ]);
    expect(fanSlots(1, 'rotated')).toEqual([{ rotate: 0, dy: 0 }]);
    expect(fanSlots(3, 'flat').every((x) => x.rotate === 0 && x.dy === 0)).toBe(true);
    expect(fanSlots(2, 'carousel').every((x) => x.rotate === 0 && x.dy === 0)).toBe(true);
  });

  test('selecting one draft then another pairs them for the comparison; deselecting clears it', () => {
    const hand = ['a', 'b', 'c'];
    let t = nextPair({ prev: null, cur: null }, 'a', hand);
    expect(t).toEqual({ prev: null, cur: 'a' });
    t = nextPair(t, 'b', hand);
    expect(t).toEqual({ prev: 'a', cur: 'b' });
    expect(nextPair(t, 'b', hand)).toBe(t);
    expect(nextPair(t, 'c', hand)).toEqual({ prev: 'b', cur: 'c' });
    expect(nextPair(t, null, hand)).toEqual({ prev: null, cur: null });
    expect(nextPair(t, 'deck-card', hand)).toEqual({ prev: null, cur: 'deck-card' });
  });

  test('the strap draws the view figures to scale: fill, the allowance notch, the ghost segment both ways', () => {
    const w = { now: 104, allowance: 1200, over: false, noGrowth: false, raisedBy: null };
    expect(strapGeom(w, { before: 104, after: 172 })).toEqual({ fill: 8.7, notch: 100, ghost: { from: 8.7, to: 14.3, grows: true } });
    expect(strapGeom(w, { before: 104, after: 104 }).ghost).toBeNull();
    expect(strapGeom(w, { before: 172, after: 157 }).ghost).toEqual({ from: 13.1, to: 14.3, grows: false });
    const over = strapGeom({ ...w, now: 1500, over: true }, null);
    expect(over.fill).toBe(100);
    expect(over.notch).toBe(80);
  });

  test('a tab prints the whole-file delta of the view, signed', () => {
    expect(signedDelta({ delta: 68 })).toBe('+68');
    expect(signedDelta({ delta: -15 })).toBe('−15');
    expect(signedDelta({ delta: 0 })).toBe('no change');
  });

  test('the comparison aligns two previews head by head', () => {
    const g = { before: 0, after: 0, delta: 0, line: 0, blockHeader: 0, other: 0, text: 'no change' };
    const pv = (heads: DragPreview['heads']): DragPreview => ({ verb: 'play', heads, ghost: { claude: g, codex: g }, line: null, accepts: [], refused: null });
    const rows = compareRows(pv([{ caseId: 'x', glow: true, word: null }, { caseId: 'y', glow: false, word: 'Codex' }]), pv([{ caseId: 'y', glow: true, word: null }]));
    expect(rows).toEqual([
      { caseId: 'x', a: { glow: true, word: null }, b: null },
      { caseId: 'y', a: { glow: false, word: 'Codex' }, b: { glow: true, word: null } },
    ]);
  });

  test('the world plate lands its painted table edge on the shore line and the wood reaches the bottom', () => {
    for (const [w, h] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ] as const) {
      const b = layout({ w, h });
      const plate = b.mode === 'phone' ? PLATES.portrait : PLATES.raised;
      const at = placePlate(plate, w, b.shoreY, h);
      expect(at.top + plate.edge * at.scale).toBeCloseTo(b.shoreY, 6);
      expect(at.width).toBeGreaterThanOrEqual(w);
      const bottom = at.ext.reduce((y, x) => Math.max(y, x.top + x.height), at.top + at.height);
      expect(bottom).toBeGreaterThanOrEqual(h);
    }
  });

  test('the Table bands are the exact Bands boxes, contiguous, never overlapping (§0a.17)', () => {
    const expectStage = { '1440x900': [72, 405, 283], '1024x768': [45, 307, 276], '390x844': [0, 310, 388] } as const;
    for (const [key, [sky, creature, wood]] of Object.entries(expectStage)) {
      const [w, h] = key.split('x').map(Number) as [number, number];
      const b = layout({ w, h });
      const t = tableBoxes(b);
      expect(t.stage.h).toBe(sky + creature);
      expect(t.wood.h).toBe(wood);
      expect(t.header.y + t.header.h).toBe(t.stage.y);
      expect(t.stage.y + t.stage.h).toBe(t.wood.y);
      expect(t.wood.y + t.wood.h).toBe(t.status.y);
      expect(t.height).toBe(h);
      expect(t.status.h).toBe(50);
    }
  });
});

// ------------------------------------------------------------------ the pixel check (headless Chrome, real fonts)

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FONTS =
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Shippori+Mincho+B1:wght@600;800&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=Lora:ital,wght@1,400;1,500&display=block';

interface Face {
  key: string;
  size: 'S' | 'M' | 'L';
  mode: string;
  fit: string;
  title: string;
  box: { w: number; h: number };
  over: string[];
}

/** A minimal Chrome DevTools Protocol client over Bun's WebSocket: one page, evaluate, screenshot. */
class Cdp {
  private id = 0;
  private wait = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      const w = m.id !== undefined ? this.wait.get(m.id) : undefined;
      if (!w) return;
      this.wait.delete(m.id);
      if (m.error) w.no(new Error(m.error.message));
      else w.ok(m.result);
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((ok, no) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => ok(new Cdp(ws)));
      ws.addEventListener('error', () => no(new Error('CDP socket failed')));
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, no) => this.wait.set(id, { ok, no }));
  }
  close(): void {
    this.ws.close();
  }
}

interface PageRun {
  /** The page's module source; it reads /data.json and sets window.__result and window.__done. */
  entry: string;
  data: unknown;
  viewport: { w: number; h: number; mobile?: boolean };
  bodyCss?: string;
  shot?: string;
  fullPage?: boolean;
}

/** Bundle a page with Bun, serve it with the repo's public folder, render it in an isolated headless Chrome. */
async function renderPage<T>(run: PageRun): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pl-cards-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, run.entry);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  const js = await built.outputs.find((o) => o.kind === 'entry-point')!.text();
  const css = (await Promise.all(built.outputs.filter((o) => o.path.endsWith('.css')).map((o) => o.text()))).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${FONTS}"><style>${run.bodyCss ?? ''}</style><style>${css}</style></head><body><div id="root"></div><script type="module">${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`;
  const publicDir = join(import.meta.dir, '..', 'public');
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      if (path === '/data.json') return Response.json(run.data);
      const f = Bun.file(join(publicDir, path));
      return f.size ? new Response(f) : new Response('', { status: 404 });
    },
  });
  const profile = join(dir, 'profile');
  const proc = Bun.spawn([CHROME, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
  let cdp: Cdp | null = null;
  try {
    // Chrome writes its port file once it listens; wait until both lines (port, browser socket path) are there.
    const portFile = join(profile, 'DevToolsActivePort');
    let lines: string[] = [];
    for (let i = 0; i < 150 && lines.length < 2; i++) {
      await Bun.sleep(100);
      if (existsSync(portFile)) lines = readFileSync(portFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    }
    if (lines.length < 2) throw new Error('headless Chrome did not open its debugging port');
    const [port, path] = lines;
    cdp = await Cdp.open(`ws://127.0.0.1:${port}${path}`);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const { w, h, mobile = false } = run.viewport;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/` }, sessionId);
    let result: T | null = null;
    for (let i = 0; i < 300 && !result; i++) {
      await Bun.sleep(100);
      const r = await cdp.send('Runtime.evaluate', { expression: 'window.__done ? JSON.stringify(window.__result) : null', returnByValue: true }, sessionId);
      if (r.result?.value) result = JSON.parse(r.result.value);
    }
    if (!result) throw new Error('the page never finished rendering');
    if (run.shot) {
      if (run.fullPage) {
        const { contentSize } = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: Math.ceil(contentSize.height), deviceScaleFactor: 1, mobile }, sessionId);
      }
      const png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!run.fullPage }, sessionId);
      writeFileSync(run.shot, Buffer.from(png.data, 'base64'));
    }
    return result;
  } finally {
    try {
      await cdp?.send('Browser.close');
    } catch {
      /* already closing */
    }
    cdp?.close();
    proc.kill();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

const SRC = join(import.meta.dir, '..', 'src', 'ui', 'playloop');
const FONT_WAIT = `const families = ['600 16px "Shippori Mincho B1"', '400 14px "Zen Kaku Gothic New"', '500 12px "Zen Kaku Gothic New"', '400 12px "JetBrains Mono"', '600 12px "JetBrains Mono"'];
await Promise.all(families.map((f) => document.fonts.load(f, 'Aa1')));
await document.fonts.ready;
const loaded = families.filter((f) => document.fonts.check(f, 'Aa1') && [...document.fonts].some((ff) => ff.status === 'loaded' && f.includes(ff.family.replace(/"/g, ''))));`;

async function renderFaces(cards: CardView[], sizes: ('S' | 'M' | 'L')[], shot?: string): Promise<{ faces: Face[]; fonts: string[] }> {
  return renderPage({
    viewport: { w: 1440, h: 900 },
    data: { cards, sizes },
    shot,
    fullPage: true,
    bodyCss: 'body{margin:0;padding:40px;background:#3a2418}.row{display:flex;flex-wrap:wrap;gap:34px 30px;margin-bottom:40px}',
    entry: `import { Card, refitCards } from ${JSON.stringify(join(SRC, 'cards', 'card.ts'))};
const data = await (await fetch('/data.json')).json();
const root = document.getElementById('root');
for (const size of data.sizes) {
  const row = document.createElement('section');
  row.className = 'row';
  for (const c of data.cards) {
    const n = Card({ card: c, size, selected: false, drag: null, onInspect() {} });
    n.dataset.key = c.id + ':' + (c.footer ? c.footer.text : '');
    row.append(n);
  }
  root.append(row);
}
${FONT_WAIT}
refitCards();
const faces = [...document.querySelectorAll('.pl-cards-card')].map((n) => {
  const over = [];
  const z = (sel) => n.querySelector(sel);
  const wide = (e) => e && e.scrollWidth > e.clientWidth + 0.5;
  const tall = (e) => e && e.scrollHeight > e.clientHeight + 0.5;
  if (n.dataset.title === 'overflow' || wide(z('.pl-cards-title'))) over.push('title');
  if (wide(z('.pl-cards-top')) || tall(z('.pl-cards-top'))) over.push('top band');
  const top = z('.pl-cards-top').getBoundingClientRect();
  for (const k of z('.pl-cards-top').children) { const r = k.getBoundingClientRect(); if (r.right > top.right + 0.5 || r.left < top.left - 0.5) over.push('top band item'); }
  const text = z('.pl-cards-text'), sum = z('.pl-cards-summary');
  if (n.dataset.fit !== 'excerpt' && n.dataset.fit !== 'fallback' && (text.scrollHeight > sum.clientHeight + 0.5 || wide(text))) over.push('summary');
  if (n.dataset.fit === 'fallback') over.push('summary needed the excerpt fallback');
  const mark = z('.pl-cards-mark');
  if (mark && (wide(mark) || mark.getBoundingClientRect().bottom > sum.getBoundingClientRect().bottom + 0.5)) over.push('excerpt mark');
  const foot = z('.pl-cards-foot');
  if (wide(foot) || tall(foot)) over.push('footer');
  for (const k of foot.querySelectorAll('span')) if (k.scrollWidth > k.clientWidth + 0.5 || k.getBoundingClientRect().right > foot.getBoundingClientRect().right + 0.5) over.push('footer line');
  const b = n.getBoundingClientRect();
  return { key: n.dataset.key, size: n.dataset.size, mode: n.dataset.fit, fit: n.dataset.fit, title: z('.pl-cards-title').textContent, box: { w: b.width, h: b.height }, over: [...new Set(over)] };
});
window.__result = { faces, fonts: loaded };
window.__done = true;
`,
  });
}

describe('card faces by rendered pixels', () => {
  const have = existsSync(CHROME);
  let faces: Face[] = [];
  let fonts: string[] = [];
  let drafts: CardView[] = [];
  beforeAll(async () => {
    if (!have) return;
    const sample = sampleCards();
    drafts = sample.drafts;
    // One retry: a cold Chrome start or a slow font response is not a face overflow.
    let r: { faces: Face[]; fonts: string[] };
    try {
      r = await renderFaces(sample.all, ['M', 'L', 'S'], process.env.ERRATA_FACE_SHOT);
      if (r.fonts.length < 5) throw new Error(`web fonts loaded: ${r.fonts.length} of 5`);
    } catch (e) {
      console.warn(`face render retry after: ${(e as Error).message}`);
      r = await renderFaces(sample.all, ['M', 'L', 'S'], process.env.ERRATA_FACE_SHOT);
    }
    faces = r.faces;
    fonts = r.fonts;
  }, 60_000);
  afterAll(() => undefined);

  test.skipIf(!have)('the real web fonts loaded (the check is meaningless with fallback faces)', () => {
    expect(fonts.length).toBe(5);
  });

  test.skipIf(!have)('every sample draft at M fits its five zones without the excerpt fallback', () => {
    const keys = new Set(drafts.map((c) => `${c.id}:${c.footer?.text ?? ''}`));
    const m = faces.filter((f) => f.size === 'M' && keys.has(f.key));
    expect(m.length).toBe(keys.size);
    expect(m.filter((f) => f.over.length > 0).map((f) => `${f.title}: ${f.over.join(', ')}`)).toEqual([]);
  });

  test.skipIf(!have)('every card the sample run shows fits at M and L; boxes are exactly the §10 sizes', () => {
    for (const f of faces) expect(f.box).toEqual(CARD_BOX[f.size]);
    const bad = faces.filter((f) => f.size !== 'S' && f.over.length > 0).map((f) => `${f.size} ${f.title}: ${f.over.join(', ')}`);
    expect(bad).toEqual([]);
  });

  test.skipIf(!have)('S is an overview: a face may become a marked excerpt there, but nothing spills out of a zone', () => {
    const bad = faces.filter((f) => f.size === 'S' && f.over.some((o) => o !== 'summary needed the excerpt fallback')).map((f) => `${f.title}: ${f.over.join(', ')}`);
    expect(bad).toEqual([]);
  });
});

// ------------------------------------------------------------------ the Table at the three viewports

interface TableRun {
  bands: Record<string, { top: number; height: number }>;
  targets: { id: string; x: number; y: number; w: number; h: number }[];
  wood: { top: number; bottom: number };
  faces: { top: number; bottom: number; left: number; right: number }[];
  groups: { cls: string; left: number; right: number; top: number; bottom: number }[];
  controls: { cls: string; w: number; h: number }[];
  page: { left: number; right: number } | null;
  vw: number;
  vh: number;
  scrollW: number;
}

/** A dealt room with the most drafts in the sample (three), its books, piles and route. */
function dealtRoom(): { room: RoomView; preview: DragPreview | null } {
  let s = fresh();
  let best: RoomView | null = null;
  for (let i = 0; i < 24; i++) {
    const sc = A.selectScreen(s);
    if (sc.kind === 'room' || sc.kind === 'event') {
      for (const h of sc.view.heads) s = A.actStamp(s, h.caseId, 'issue');
      s = A.actDeal(s);
      const v = A.selectRoom(s)!;
      if (!best || v.hand.length > best.hand.length) best = v;
      s = v.hand.length ? A.actPlay(s, v.hand[0]!.id, 'beast').state : A.actSkip(s).state;
    }
    if (sc.kind === 'boss' || sc.kind === 'apply') break;
    s = A.actAdvance(s);
  }
  return { room: best!, preview: best!.hand[0]?.playPreview ?? null };
}

async function renderTable(w: number, h: number, shot?: string): Promise<TableRun> {
  const { room, preview } = dealtRoom();
  const bands: Bands = layout({ w, h });
  return renderPage<TableRun>({
    viewport: { w, h, mobile: w < 600 },
    data: { room, preview, bands },
    shot,
    bodyCss: 'body{margin:0}',
    entry: `import { Table, RouteHeader, StatusBar } from ${JSON.stringify(join(SRC, 'layout', 'index.ts'))};
import { Books, Hand, Piles } from ${JSON.stringify(join(SRC, 'cards', 'index.ts'))};
const d = await (await fetch('/data.json')).json();
const targets = [];
const drag = { bindCard: () => () => {}, bindTarget: (id, target, el) => { targets.push({ id, el }); return () => {}; } };
const noop = () => null;
const api = new Proxy({}, { get: (_, k) => (k === 'campfire' || k === 'boss' || k === 'apply' ? new Proxy({}, { get: () => noop }) : noop) });
const b = d.bands;
const first = d.room.hand[0];
const ui = { selected: first ? first.id : null, inspect: null, inspector: null, drag: d.preview ? { cardId: first.id, target: { kind: 'beast' }, preview: d.preview } : null, effect: null, tutorial: null, beat: 'deal', reducedMotion: true, bands: b, notice: 'The line is on the table. Do it again to play it.', pending: null };
const wood = document.createElement('div');
wood.className = 'pl-wood';
wood.append(Books({ books: d.room.books, preview: d.preview, mode: 'play', layout: b.books.mode, drag }), Hand({ cards: d.room.hand, bands: b, ui, api, drag }), Piles({ piles: d.room.piles, layout: b.piles.mode, shelfTarget: true, api, drag }));
const stage = document.createElement('section');
const table = Table({ bands: b, header: RouteHeader({ route: d.room.route, title: d.room.beast.name, subtitle: d.room.beast.subtitle }), stage, wood, status: StatusBar({ status: d.room.status, notice: ui.notice }) });
document.getElementById('root').append(table);
${FONT_WAIT}
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const rect = (e) => e.getBoundingClientRect();
const bands = {};
for (const k of ['header', 'stage', 'wood', 'status']) { const r = rect(document.querySelector('.pl-layout-' + k)); bands[k] = { top: Math.round(r.top), height: Math.round(r.height) }; }
const woodR = rect(document.querySelector('.pl-layout-wood'));
const page = document.querySelector('.pl-cards-page');
window.__result = {
  bands,
  targets: targets.map(({ id, el }) => { const r = rect(el); return { id, x: r.left, y: r.top, w: r.width, h: r.height }; }),
  wood: { top: woodR.top, bottom: woodR.bottom },
  faces: [...document.querySelectorAll('.pl-cards-hand:not(.pl-cards-hand-carousel) .pl-cards-face')].map((e) => { const r = rect(e); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }),
  groups: [...document.querySelectorAll('.pl-wood > *')].map((e) => { const r = rect(e); return { cls: e.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }),
  controls: [...document.querySelectorAll('.pl-cards-inspect, .pl-layout-knot, .pl-cards-fan')].map((e) => { const r = rect(e); return { cls: e.className, w: r.width, h: r.height }; }),
  page: page ? { left: rect(page).left, right: rect(page).right } : null,
  vw: innerWidth,
  vh: innerHeight,
  scrollW: document.documentElement.scrollWidth,
};
window.__done = true;
`,
  });
}

/** The gap between two rectangles (0 when they touch or overlap). */
function gap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0);
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0);
  return Math.max(dx, dy);
}

describe('the Table by rendered pixels', () => {
  const have = existsSync(CHROME);
  for (const [w, h] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    test.skipIf(!have)(
      `${w}×${h}: exact bands, every drop target at least 44 px and 8 px apart, nothing spilling out of the wood`,
      async () => {
        const shots = process.env.ERRATA_TABLE_SHOTS;
        const r = await renderTable(w, h, shots ? join(shots, `table-test-${w}x${h}.png`) : undefined);
        const t = tableBoxes(layout({ w, h }));
        expect(r.bands).toEqual({ header: { top: t.header.y, height: t.header.h }, stage: { top: t.stage.y, height: t.stage.h }, wood: { top: t.wood.y, height: t.wood.h }, status: { top: t.status.y, height: t.status.h } });
        expect(r.scrollW).toBeLessThanOrEqual(w);
        const ids = r.targets.map((x) => x.id).sort();
        expect(ids).toEqual(['book:claude:play', 'book:codex:play', 'shelf']);
        for (const x of r.targets) {
          expect(x.w).toBeGreaterThanOrEqual(44);
          expect(x.h).toBeGreaterThanOrEqual(44);
        }
        for (let i = 0; i < r.targets.length; i++) for (let j = i + 1; j < r.targets.length; j++) expect(gap(r.targets[i]!, r.targets[j]!)).toBeGreaterThanOrEqual(8);
        for (const c of r.controls) expect(Math.min(c.w, c.h)).toBeGreaterThanOrEqual(44);
        for (const g of r.groups) {
          expect(g.left).toBeGreaterThanOrEqual(0);
          expect(g.right).toBeLessThanOrEqual(w);
          expect(g.top).toBeGreaterThanOrEqual(r.wood.top - 0.5);
          expect(g.bottom).toBeLessThanOrEqual(r.wood.bottom + 0.5);
        }
        // Cards may lift 8 px over the shore when selected; they never leave the wood at the bottom.
        for (const f of r.faces) {
          expect(f.top).toBeGreaterThanOrEqual(r.wood.top - 8.5);
          expect(f.bottom).toBeLessThanOrEqual(r.wood.bottom + 0.5);
        }
        if (r.page) {
          expect(r.page.left).toBeGreaterThanOrEqual(0);
          expect(r.page.right).toBeLessThanOrEqual(w);
        }
      },
      60_000,
    );
  }
});

// ------------------------------------------------------------------ the inspector and the comparison, rendered

interface InspectorRun {
  calls: [string, ...unknown[]][];
  accept: number;
  exactMono: boolean;
  estimatedBeside: boolean;
  queue: number;
  compare: { titles: string[]; heads: number } | null;
  noCompareAfterClear: boolean;
}

describe('the inspector by rendered pixels', () => {
  const have = existsSync(CHROME);
  test.skipIf(!have)(
    'mapping rows offer Accept only when eligible and not accepted; a case shows its room queue; two selections compare',
    async () => {
      let s = fresh();
      for (const h of A.selectRoom(s)!.heads) s = A.actStamp(s, h.caseId, 'issue');
      s = A.actDeal(s);
      const id = A.selectRoom(s)!.hand[0]!.id;
      s = A.actPlay(s, id, 'claude').state;
      s = A.actRetarget(s, id, 'both');
      const view = A.selectInspector(s, { cardId: id })!;
      const room = A.selectRoom(s)!;
      const caseView = A.selectInspector(s, { caseId: room.heads[1]!.caseId })!;
      const { room: dealt } = dealtRoom();
      const shot = process.env.ERRATA_TABLE_SHOTS ? join(process.env.ERRATA_TABLE_SHOTS, 'inspector-test-1440x900.png') : undefined;
      const r = await renderPage<InspectorRun>({
        viewport: { w: 1440, h: 900 },
        data: { view, caseView, hand: dealt.hand, bands: layout({ w: 1440, h: 900 }) },
        shot,
        bodyCss: 'body{margin:0;background:#3a2418}',
        entry: `import { Inspector, Hand } from ${JSON.stringify(join(SRC, 'cards', 'index.ts'))};
const d = await (await fetch('/data.json')).json();
const calls = [];
const rec = (name) => (...a) => { calls.push([name, ...a]); return null; };
const api = new Proxy({}, { get: (_, k) => (k === 'campfire' || k === 'boss' || k === 'apply' ? new Proxy({}, { get: (_, j) => rec(k + '.' + String(j)) }) : rec(String(k))) });
const root = document.getElementById('root');
const insp = Inspector({ card: null, receipt: null, layout: 'side', api, view: d.view });
root.append(insp);
${FONT_WAIT}
const accepts = [...insp.querySelectorAll('button')].filter((b) => b.textContent === 'Accept');
accepts.forEach((b) => b.click());
const exact = insp.querySelector('.pl-cards-exact');
const wm = insp.querySelector('.pl-cards-weightmath');
const caseInsp = Inspector({ card: null, receipt: null, layout: 'sheet', api, view: d.caseView });
const qs = [...caseInsp.querySelectorAll('.pl-cards-qbtn')];
qs[0]?.click();
const ui = (sel) => ({ selected: sel, inspect: null, inspector: null, drag: null, effect: null, tutorial: null, beat: 'deal', reducedMotion: true, bands: d.bands, notice: null, pending: null });
const drag = { bindCard: () => () => {}, bindTarget: () => () => {} };
Hand({ cards: d.hand, bands: d.bands, ui: ui(d.hand[0].id), api, drag });
const hand = Hand({ cards: d.hand, bands: d.bands, ui: ui(d.hand[1].id), api, drag });
const cmp = hand.querySelector('.pl-cards-compare');
const cleared = Hand({ cards: d.hand, bands: d.bands, ui: ui(null), api, drag });
window.__result = {
  calls,
  accept: accepts.length,
  exactMono: !!exact && getComputedStyle(exact).fontFamily.includes('JetBrains Mono') && exact.textContent === d.view.card.inspector.exact,
  estimatedBeside: !!wm && wm.textContent.includes(d.view.card.inspector.weightMath) && wm.textContent.includes('estimated'),
  queue: qs.length,
  compare: cmp ? { titles: [...cmp.querySelectorAll('.pl-cards-cmp-title')].map((b) => b.textContent), heads: cmp.querySelectorAll('.pl-cards-cmp-heads li').length } : null,
  noCompareAfterClear: !cleared.querySelector('.pl-cards-compare'),
};
window.__done = true;
`,
      });
      const cardView = view.kind === 'card' ? view : null;
      const open = cardView!.mappings.filter((m) => m.eligible && !m.accepted);
      expect(open.length).toBeGreaterThan(0);
      expect(r.accept).toBe(open.length);
      expect(r.calls.filter((c) => c[0] === 'campfire.acceptMapping')).toEqual(open.map((m) => ['campfire.acceptMapping', m.cardId, m.caseId]));
      expect(r.exactMono).toBe(true);
      expect(r.estimatedBeside).toBe(true);
      expect(caseView.kind).toBe('case');
      expect(r.queue).toBe(caseView.kind === 'case' ? caseView.queue.length : -1);
      expect(r.calls.some((c) => c[0] === 'inspect')).toBe(true);
      expect(r.compare?.titles).toEqual([dealt.hand[0]!.face.title, dealt.hand[1]!.face.title]);
      expect(r.noCompareAfterClear).toBe(true);
    },
    60_000,
  );

  test.skipIf(!have)(
    "a Skill's inspector shows its SKILL.md first lines and its estimate outside the allowance",
    async () => {
      let s = fresh();
      for (let i = 0; i < 20 && A.currentNode(s)?.kind !== 'workshop'; i++) {
        const sc = A.selectScreen(s);
        if (sc.kind === 'room' || sc.kind === 'event') {
          for (const h of sc.view.heads) s = A.actStamp(s, h.caseId, 'issue');
          s = A.actDeal(s);
          const v = A.selectRoom(s)!;
          s = v.hand.length ? A.actPlay(s, v.hand[0]!.id, 'beast').state : A.actSkip(s).state;
        }
        s = A.actAdvance(s);
      }
      s = A.actDeal(s);
      const skill = A.selectRoom(s)!.hand.find((c) => c.type === 'skill')!;
      const view = A.selectInspector(s, { cardId: skill.id })!;
      expect(view.kind === 'card' && view.card.inspector.skill).toBeTruthy();
      const r = await renderPage<{ text: string; pre: string }>({
        viewport: { w: 1440, h: 900 },
        data: { view },
        entry: `import { Inspector } from ${JSON.stringify(join(SRC, 'cards', 'index.ts'))};
const d = await (await fetch('/data.json')).json();
const api = new Proxy({}, { get: () => new Proxy(() => null, { get: () => () => null }) });
const n = Inspector({ card: null, receipt: null, layout: 'side', api, view: d.view });
document.getElementById('root').append(n);
window.__result = { text: n.textContent, pre: n.querySelector('.pl-cards-skill')?.textContent ?? '' };
window.__done = true;
`,
      });
      const sk = view.kind === 'card' ? view.card.inspector.skill! : null;
      expect(r.pre).toBe(sk!.firstLines.join('\n'));
      expect(r.text).toContain(`+${sk!.estimate} estimated · outside the allowance`);
    },
    60_000,
  );
});
