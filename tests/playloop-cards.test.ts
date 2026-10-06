// The base layer (cards/layout): pure helpers, and the pixel check of every sample card face at M (§0a.20: validate
// faces by rendered pixels, not character counts). The pixel check renders the real Card component with the real web
// fonts in an isolated headless Chrome and fails on any overflow.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDeck } from '../src/deck/deck';
import * as A from '../src/ui/playloop/adapter';
import type { CardView } from '../src/ui/playloop/contract';
import { COPY, footerText } from '../src/ui/playloop/contract';
import { CARD_BOX, faceText, footerParts } from '../src/ui/playloop/cards/card';
import { cardArt, fig, splitCode } from '../src/ui/playloop/cards/dom';
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

async function renderFaces(cards: CardView[], sizes: ('S' | 'M' | 'L')[], shot?: string): Promise<{ faces: Face[]; fonts: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'pl-cards-'));
  const entry = join(dir, 'entry.ts');
  const cardModule = join(import.meta.dir, '..', 'src', 'ui', 'playloop', 'cards', 'card.ts');
  writeFileSync(
    entry,
    `import { Card, refitCards } from ${JSON.stringify(cardModule)};
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
const families = ['600 16px "Shippori Mincho B1"', '400 14px "Zen Kaku Gothic New"', '500 12px "Zen Kaku Gothic New"', '400 12px "JetBrains Mono"', '600 12px "JetBrains Mono"'];
await Promise.all(families.map((f) => document.fonts.load(f, 'Aa1')));
await document.fonts.ready;
refitCards();
const loaded = families.filter((f) => document.fonts.check(f, 'Aa1') && [...document.fonts].some((ff) => ff.status === 'loaded' && f.includes(ff.family.replace(/"/g, ''))));
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
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  const js = await built.outputs.find((o) => o.kind === 'entry-point')!.text();
  const css = (await Promise.all(built.outputs.filter((o) => o.path.endsWith('.css')).map((o) => o.text()))).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}"><style>body{margin:0;padding:40px;background:#3a2418}.row{display:flex;flex-wrap:wrap;gap:34px 30px;margin-bottom:40px}</style><style>${css}</style></head><body><div id="root"></div><script type="module">${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`;
  const publicDir = join(import.meta.dir, '..', 'public');
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      if (path === '/data.json') return Response.json({ cards, sizes });
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/` }, sessionId);
    let result: { faces: Face[]; fonts: string[] } | null = null;
    for (let i = 0; i < 300 && !result; i++) {
      await Bun.sleep(100);
      const r = await cdp.send('Runtime.evaluate', { expression: 'window.__done ? JSON.stringify(window.__result) : null', returnByValue: true }, sessionId);
      if (r.result?.value) result = JSON.parse(r.result.value);
    }
    if (!result) throw new Error('the face page never finished rendering');
    if (shot) {
      const { contentSize } = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: Math.ceil(contentSize.height), deviceScaleFactor: 1, mobile: false }, sessionId);
      const png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
      writeFileSync(shot, Buffer.from(png.data, 'base64'));
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
