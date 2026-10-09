// Drives the built app on the synthetic sample to the six screens the text-density test measures, by keys and clicks
// a player could make: import, mirror, room 1 dealt, the first campfire with a gold preview, the boss's first head,
// and Apply's diffs. Also counts the visible words at rest (tests/playloop-text-density.test.ts).
import type { Page } from './cdp';

export type ScreenKey = 'import' | 'mirror' | 'room' | 'campfire' | 'boss' | 'apply';
export const SCREENS: ScreenKey[] = ['import', 'mirror', 'room', 'campfire', 'boss', 'apply'];

const title = "(document.querySelector('.pl-layout-title, h1')?.textContent ?? '')";
const has = (label: string) => `[...document.querySelectorAll('button, [role=button]')].some((b) => b.offsetParent && !b.disabled && (b.textContent.trim().startsWith(${JSON.stringify(label)}) || (b.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(label)})))`;
const clickBy = (label: string) => `[...document.querySelectorAll('button, [role=button]')].find((b) => b.offsetParent && !b.disabled && (b.textContent.trim().startsWith(${JSON.stringify(label)}) || (b.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(label)})))`;

async function press(p: Page, label: string): Promise<void> {
  await p.eval(`(() => { const b = ${clickBy(label)}; if (!b) throw new Error('no button ' + ${JSON.stringify(label)}); b.scrollIntoView({ block: 'center' }); })()`);
  const c = await p.eval<{ x: number; y: number }>(`(() => { const b = ${clickBy(label)}.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await p.eval(`(() => { const b = ${clickBy(label)}; b.click(); })()`);
  void c;
}

async function settle(p: Page, ms = 600): Promise<void> {
  await Bun.sleep(ms);
}

/** Stamp every head of the room on screen with `key`, then Enter (deal, or continue). */
async function stampAll(p: Page, key: string): Promise<void> {
  for (let i = 0; i < 6 && (await p.eval<boolean>("!!document.querySelector('.pl-room-stamp:not([disabled])')")); i++) {
    await p.key(key);
    await settle(p, 250);
    if (await p.eval<boolean>("!document.querySelector('[aria-label^=\"Codex\"][aria-label$=\"not yet read\"], [aria-label$=\"to read\"]')")) break;
  }
}

export async function toScreen(p: Page, which: ScreenKey): Promise<void> {
  await p.goto('/');
  await p.until("document.querySelector('input.mt-file')");
  await settle(p, 500);
  if (which === 'import') return;
  await press(p, 'Play the synthetic sample');
  await p.until("document.querySelector('.mt-start')");
  await settle(p, 500);
  if (which === 'mirror') return;
  await press(p, 'Start the act');
  await p.until("document.querySelector('.pl-room-stamp')");
  await settle(p);
  for (let i = 0; i < 3; i++) {
    await p.key('a');
    await settle(p, 250);
  }
  await p.key('Enter');
  await p.until("document.querySelector('.pl-cards-hand [role=button]')");
  await settle(p, 900);
  if (which === 'room') return;
  await p.key('Enter');
  await p.until(has('Continue'));
  await p.key('Enter');
  await p.until(`${title}.includes('change of plan')`);
  await settle(p);
  await p.key('c');
  await settle(p, 300);
  await p.key('Enter');
  await p.until(`${title} === 'Campfire'`);
  await settle(p);
  if (which === 'campfire') {
    // The uv gold thread: select it, then click one of its cards and then another (tap–tap stacks: the preview).
    await press(p, 'Gold thread');
    await settle(p, 600);
    const mark = `(() => { const cs = [...document.querySelectorAll('.pl-cards-card[role=button]')].filter((c) => c.offsetParent && /\\buv\\b/.test(c.getAttribute('aria-label') ?? '')); cs.forEach((c, i) => c.setAttribute('data-nav', String(i))); return cs.length; })()`;
    if ((await p.eval<number>(mark)) >= 2) {
      await p.clickAt('[data-nav="0"]');
      await settle(p, 400);
      await p.eval(mark);
      await p.clickAt('[data-nav="1"]');
      await settle(p, 900);
    }
    return;
  }
  // Onward to the boss: leave each fire, set every later head aside, skip the workshop's hand.
  for (let i = 0; i < 40; i++) {
    const t = await p.eval<string>(title);
    if (process.env.NAV_DEBUG) console.log(i, t, await p.eval<string>("[...document.querySelectorAll('button,[role=button]')].filter((b) => b.offsetParent && !b.disabled).map((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '').slice(0, 24)).join(' | ')"));
    if (t === 'Later cases') break;
    if (t === 'Campfire') {
      await press(p, 'Leave');
    } else if (await p.eval<boolean>(has('Continue'))) {
      await press(p, 'Continue');
    } else if (await p.eval<boolean>(has('Deal'))) {
      await press(p, 'Deal');
    } else if (await p.eval<boolean>("!!document.querySelector('.pl-room-stamp:not([disabled])')")) {
      await p.key('n');
    } else if (await p.eval<boolean>("!!document.querySelector('.pl-cards-hand [role=button]')")) {
      // The workshop's hand: shelve it (skip).
      await p.eval("document.querySelector('[aria-label^=\"Shelf\"]')?.click()");
      await settle(p, 300);
      if (await p.eval<boolean>(has('Skip'))) await press(p, 'Skip');
    } else await p.key('Enter');
    await settle(p, 450);
  }
  await p.until(`${title} === 'Later cases'`);
  await settle(p, 900);
  if (which === 'boss') return;
  for (let i = 0; i < 30; i++) {
    if (await p.eval<boolean>("!!document.querySelector('.pl-end-diff, .pl-end-diffs')")) break;
    if (await p.eval<boolean>(has('Not a problem'))) await press(p, 'Not a problem');
    else if (await p.eval<boolean>(has('Continue'))) await press(p, 'Continue');
    else if (await p.eval<boolean>(has('On to Apply'))) await press(p, 'On to Apply');
    else if (await p.eval<boolean>(has('Apply'))) await press(p, 'Apply');
    else await p.key('Enter');
    await settle(p, 450);
  }
  await settle(p, 600);
}

/**
 * Visible words at rest: every text node whose element is rendered, not hidden, and inside the viewport, outside the
 * content the player reads as data (the receipt quote, the card sentences, a textarea, the diff bodies). The card
 * sentences include every place a card's own line is printed: the face's summary, a book's slips, a thread's member
 * lines at the campfire and the reading on the open page. A word is a
 * whitespace-separated run with a letter or a digit in it.
 */
export const COUNT_WORDS = `(() => {
  const skip = '.pl-room-quote, .pl-end-quote, .pl-end-lines-diff, .pl-cards-summary, .pl-cards-slip-text, .pl-campfire-thread-members, textarea, .pl-end-diffbody, .pl-end-diff pre, .pl-end-diff-body, [data-density="content"], .ui-tip, .ui-note';
  const vw = innerWidth, vh = innerHeight;
  const words = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const e = n.parentElement;
    if (!e || e.closest(skip) || e.closest('script, style, [hidden], [aria-hidden="true"] text')) continue;
    if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    const b = r.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || b.right < 0 || b.bottom < 0 || b.left > vw || b.top > vh) continue;
    let o = e, faint = false;
    for (; o; o = o.parentElement) if (parseFloat(getComputedStyle(o).opacity) < 0.05) { faint = true; break; }
    if (faint) continue;
    for (const w of n.textContent.split(/\\s+/)) if (/[\\p{L}\\p{N}]/u.test(w)) words.push(w);
  }
  return words;
})()`;
