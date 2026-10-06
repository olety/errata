// A small Chrome DevTools Protocol driver for the end-to-end tests: Chrome for Testing only (tests/chrome.ts), an
// isolated profile per run, one page. It serves a folder over HTTP and lets a test evaluate, click by text, type keys
// and set the files of an <input type=file>. Nothing here touches the player's browser or files.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { CHROME_FLAGS, chromePath } from './chrome';

export const CHROME = chromePath();

class Socket {
  private id = 0;
  private wait = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  readonly events: { method: string; params: any }[] = [];
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.method) this.events.push({ method: m.method, params: m.params });
      const w = m.id !== undefined ? this.wait.get(m.id) : undefined;
      if (!w) return;
      this.wait.delete(m.id);
      if (m.error) w.no(new Error(m.error.message));
      else w.ok(m.result);
    });
  }
  static open(url: string): Promise<Socket> {
    return new Promise((ok, no) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => ok(new Socket(ws)));
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

export interface Page {
  /** Evaluate an expression (or an async function body as an IIFE string) and return its JSON value. */
  eval<T = unknown>(expression: string): Promise<T>;
  /** Wait until the expression is truthy (polls every 100 ms), or throw after `ms`. */
  until(expression: string, ms?: number): Promise<void>;
  /** Click the first <button> (or [role=button]) whose text starts with `label`, with real mouse events at its centre. */
  click(label: string): Promise<void>;
  /** Click an element by selector with real mouse events at its centre. */
  clickAt(selector: string): Promise<void>;
  key(key: string): Promise<void>;
  /** Set local files on an <input type=file> (dispatches change). */
  files(selector: string, paths: string[]): Promise<void>;
  goto(path: string): Promise<void>;
  /** Run a script in every new document before the page's own scripts. */
  before(source: string): Promise<void>;
  shot(path: string): Promise<void>;
  errors(): string[];
  readonly origin: string;
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
};

/** Serve `root` (a built site) and open it in an isolated headless Chrome for Testing. */
export async function withPage<T>(root: string, viewport: { w: number; h: number }, run: (p: Page) => Promise<T>): Promise<T> {
  if (!CHROME) throw new Error('no Chrome for Testing');
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) return new Response('', { status: 403 });
      const f = Bun.file(file);
      return f.size ? new Response(f) : new Response('', { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'errata-e2e-'));
  const profile = join(dir, 'profile');
  const proc = Bun.spawn([CHROME, ...CHROME_FLAGS, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
  let ws: Socket | null = null;
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    let lines: string[] = [];
    for (let i = 0; i < 150 && lines.length < 2; i++) {
      await Bun.sleep(100);
      if (existsSync(portFile)) lines = readFileSync(portFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    }
    if (lines.length < 2) throw new Error('headless Chrome did not open its debugging port');
    ws = await Socket.open(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    const sock = ws;
    const { targetId } = await sock.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await sock.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m: string, p: object = {}) => sock.send(m, p, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.w, height: viewport.h, deviceScaleFactor: 1, mobile: false });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    const origin = `http://127.0.0.1:${server.port}`;
    const errors = () =>
      sock.events
        .filter((e) => (e.method === 'Runtime.exceptionThrown') || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
        .map((e) => JSON.stringify(e.params).slice(0, 300));
    const evalv = async <V>(expression: string): Promise<V> => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
      return r.result?.value as V;
    };
    const centre = async (expr: string) => {
      const c = await evalv<{ x: number; y: number } | null>(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      if (!c) throw new Error(`no element for ${expr}`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) await send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    };
    const page: Page = {
      origin,
      eval: evalv,
      async until(expression, ms = 15_000) {
        for (let t = 0; t < ms; t += 100) {
          if (await evalv<boolean>(`!!(${expression})`)) return;
          await Bun.sleep(100);
        }
        throw new Error(`timed out waiting for ${expression}`);
      },
      click: (label) => centre(`[...document.querySelectorAll('button, [role=button]')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}) && !b.disabled)`),
      clickAt: (selector) => centre(`document.querySelector(${JSON.stringify(selector)})`),
      async key(key) {
        const k = KEYS[key] ?? { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: k.text });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode });
      },
      async files(selector, paths) {
        const { root: doc } = await send('DOM.getDocument', { depth: -1 });
        const { nodeId } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector });
        if (!nodeId) throw new Error(`no ${selector}`);
        await send('DOM.setFileInputFiles', { nodeId, files: paths });
      },
      async goto(path) {
        await send('Page.navigate', { url: `${origin}${path}` });
        await Bun.sleep(300);
      },
      async before(source) {
        await send('Page.addScriptToEvaluateOnNewDocument', { source });
      },
      async shot(path) {
        const png = await send('Page.captureScreenshot', { format: 'png' });
        await Bun.write(path, Buffer.from(png.data, 'base64'));
      },
      errors,
    };
    return await run(page);
  } finally {
    try {
      await ws?.send('Browser.close');
    } catch {
      /* closing */
    }
    ws?.close();
    proc.kill();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build the real app once into a temp folder with base "/" (the e2e tests serve it at the root). */
export async function buildSite(): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'errata-site-'));
  const p = Bun.spawn(['bunx', 'vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: join(import.meta.dir, '..'), env: { ...process.env, ERRATA_BASE: '/' }, stdout: 'pipe', stderr: 'pipe' });
  const code = await p.exited;
  if (code !== 0) throw new Error(`vite build failed: ${await new Response(p.stderr).text()}`);
  return out;
}
