// The one (i) pattern and the icon set for the whole game (the text-density pass, 2026-10-09). Sentences that used to
// sit on the screen live here now: a short tooltip on hover or focus (150 ms), and the full text in a note panel that
// looks like the inspector, opened by a click or a second tap on the (i). One shared tooltip element, positioned by
// code and clamped inside the viewport. Icons are inline SVG in the ink colour; no emoji, no icon font, no network.
import './info.css';

const NS = 'http://www.w3.org/2000/svg';

export type IconName =
  | 'info'
  | 'globe'
  | 'folder'
  | 'eye'
  | 'target'
  | 'seal'
  | 'quill'
  | 'shelf'
  | 'book'
  | 'fire'
  | 'urn'
  | 'scale'
  | 'rules'
  | 'knot'
  | 'lock'
  | 'cross'
  | 'bend'
  | 'tick'
  | 'question'
  | 'clock'
  | 'chat'
  | 'stop'
  | 'repeat'
  | 'wrench'
  | 'shield'
  | 'list';

/** 16 × 16 strokes, drawn a little off the grid so they read as hand-inked. A path ending in "h.05" is a dot. */
const PATHS: Record<IconName, string[]> = {
  info: ['M8 1.7c3.6-.1 6.4 2.8 6.3 6.4-.1 3.5-2.9 6.2-6.4 6.2-3.5.1-6.3-2.8-6.2-6.3.1-3.5 2.8-6.2 6.3-6.3Z', 'M8.1 7.3 7.9 11.3', 'M8 4.8h.05'],
  globe: ['M8 1.8c3.5 0 6.2 2.8 6.2 6.2S11.4 14.2 8 14.2 1.8 11.5 1.8 8 4.6 1.8 8 1.8Z', 'M8 1.9c-1.9 1.7-2.8 3.8-2.8 6.1s.9 4.4 2.8 6.1c1.9-1.7 2.8-3.8 2.8-6.1S9.9 3.6 8 1.9Z', 'M2.1 6.1c3.9.5 7.9.5 11.8-.1M2.2 10c3.9.4 7.8.4 11.7 0'],
  folder: ['M1.9 4.2c0-.6.4-1 1-1h3.3l1.5 1.6h5.4c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.9c-.6 0-1-.4-1-1Z', 'M2 6.7c4-.2 8-.2 12.1 0'],
  eye: ['M1.5 8.1C3.2 5.2 5.4 3.8 8 3.8s4.8 1.5 6.5 4.2c-1.7 2.8-3.9 4.2-6.5 4.2S3.2 10.9 1.5 8.1Z', 'M8 5.9c1.2 0 2.1.9 2.1 2.1S9.2 10.1 8 10.1 5.9 9.2 5.9 8 6.8 5.9 8 5.9Z'],
  target: ['M8 1.9c3.4 0 6.1 2.7 6.1 6.1S11.4 14.1 8 14.1 1.9 11.4 1.9 8 4.6 1.9 8 1.9Z', 'M8 4.8c1.8 0 3.2 1.4 3.2 3.2S9.8 11.2 8 11.2 4.8 9.8 4.8 8 6.2 4.8 8 4.8Z', 'M8 8h.05'],
  seal: ['M8 1.9c3 0 5.3 2.2 5.2 5.1-.1 2.8-2.3 4.9-5.2 4.9S2.8 9.8 2.8 7 5 1.9 8 1.9Z', 'M8 4.6c1.4 0 2.4 1 2.4 2.4S9.4 9.4 8 9.4 5.6 8.4 5.6 7 6.6 4.6 8 4.6Z', 'M5.3 11.3 4.4 14.6l2-1 .9-1.6M10.7 11.3l.9 3.3-2-1-.9-1.6'],
  quill: ['M13.8 2.2C9.4 2.6 5.9 6 4.3 11l-1.2 3', 'M13.8 2.2c-.4 3.4-2.9 6.3-7.1 7.4', 'M7 6.4l2.2 2'],
  shelf: ['M1.8 12.2c4.1.1 8.3.1 12.4 0', 'M2.7 12.3v1.8M13.3 12.2v1.9', 'M3.7 12V5.2h2V12M6.5 12V3.7h2V12M9.5 12.1l1.3-6.6 2 .4-1.3 6.5'],
  book: ['M8 4.4C6.4 3.2 4.3 2.9 1.8 3.2v9.1c2.5-.3 4.6 0 6.2 1.2 1.6-1.2 3.7-1.5 6.2-1.2V3.2C11.7 2.9 9.6 3.2 8 4.4Z', 'M8 4.5v8.9'],
  fire: ['M8 14.3c-2.7 0-4.6-1.9-4.6-4.3 0-2.3 1.6-3.6 2.4-5.6.4 1.1.9 1.8 1.7 2.2C7.4 4.4 8.3 2.6 10 1.7c-.3 2 .6 3.3 1.5 4.5.8 1.1 1.2 2.3 1.2 3.7 0 2.5-2 4.4-4.7 4.4Z', 'M8 14.2c-1.1 0-2-.8-2-2 0-1.1.9-1.8 1.4-2.8.8.9 2.6 1.6 2.6 3 0 1-.9 1.8-2 1.8Z'],
  urn: ['M5.1 2.4c1.9-.1 3.8-.1 5.7 0', 'M5.8 2.5c0 1.2-.6 1.7-1.6 2.6-1 .9-1.6 2.2-1.5 3.8.2 2.9 2.4 4.8 5.3 4.8s5.1-1.9 5.3-4.8c.1-1.6-.5-2.9-1.5-3.8-1-.9-1.6-1.4-1.6-2.6', 'M5.3 13.3l-.4 1.3h6.2l-.4-1.3'],
  scale: ['M8 2.2v11.4M4.6 14c2.3.1 4.5.1 6.8 0M2.6 4.4c1.8.4 3.6.4 5.4-.6 1.8 1 3.6 1 5.4.6', 'M2.6 4.5 1.2 8.6c.6 1.1 2.2 1.1 2.8 0L2.6 4.5ZM13.4 4.5 12 8.6c.6 1.1 2.2 1.1 2.8 0l-1.4-4.1Z'],
  rules: ['M3 4.6c3.3-.1 6.7-.1 10 .1M3 8.1c3.3.1 6.7.1 10 0M3 11.6c2.2-.1 4.3-.1 6.5 0'],
  knot: ['M3.3 9.9C1.7 8.4 1.9 5.9 3.7 4.8c1.9-1.2 4.2-.1 4.4 2.1.2 2.4-2.1 4.6-4.3 6.6', 'M12.7 9.9c1.6-1.5 1.4-4-.4-5.1-1.9-1.2-4.2-.1-4.4 2.1-.2 2.4 2.1 4.6 4.3 6.6'],
  lock: ['M5 7.2V5.3a3 3 0 0 1 6 0v1.9', 'M3.6 7.2c2.9-.1 5.9-.1 8.8 0v6.6c-2.9.1-5.9.1-8.8 0Z', 'M8 9.7v1.7'],
  cross: ['M4 4.2c2.6 2.5 5.3 5.1 8 7.6M12 4.1c-2.6 2.6-5.3 5.2-7.9 7.8'],
  bend: ['M3.6 12.6V7.5c0-1.6 1.2-2.8 2.8-2.8h6.4', 'M10.2 2.3l2.6 2.4-2.6 2.4'],
  tick: ['M2.8 8.7c1.1 1.1 2.2 2.2 3.3 3.2 2.4-2.5 4.7-5 7.1-7.6'],
  question: ['M5.6 5.4c.1-1.6 1.2-2.6 2.6-2.6 1.5 0 2.6 1 2.6 2.3 0 1.9-2.6 2.2-2.6 4.4', 'M8.2 12.9h.05'],
  clock: ['M8 1.9c3.4 0 6.1 2.7 6.1 6.1S11.4 14.1 8 14.1 1.9 11.4 1.9 8 4.6 1.9 8 1.9Z', 'M8 4.6v3.6l2.4 1.5'],
  chat: ['M2.2 3.6c3.9-.2 7.8-.2 11.6 0v6.8H7.4L4.3 13v-2.6H2.2Z'],
  stop: ['M3.5 3.5c3-.1 6-.1 9 0v9c-3 .1-6 .1-9 0Z', 'M6.3 6.2v3.6M9.7 6.2v3.6'],
  repeat: ['M2.6 7.2c.3-2.3 2.4-4 4.8-4 1.7 0 3.1.7 4 1.9', 'M11.9 2.4v2.9H9', 'M13.4 8.8c-.3 2.3-2.4 4-4.8 4-1.7 0-3.1-.7-4-1.9', 'M4.1 13.6v-2.9H7'],
  wrench: ['M10.7 2.2a3.3 3.3 0 0 0-3.4 4.4L2.4 11.5a1.4 1.4 0 0 0 2 2l4.9-4.9a3.3 3.3 0 0 0 4.4-3.4l-2 2-1.9-.5-.5-1.9Z'],
  shield: ['M8 1.8c1.9 1.1 3.7 1.6 5.6 1.6.1 4.9-1.7 8.5-5.6 10.8C4.1 11.9 2.3 8.3 2.4 3.4c1.9 0 3.7-.5 5.6-1.6Z'],
  list: ['M5.4 4.4c2.6-.1 5.2-.1 7.8 0M5.4 8c2.6.1 5.2.1 7.8 0M5.4 11.6c2.6-.1 5.2-.1 7.8 0', 'M2.8 4.4h.05M2.8 8h.05M2.8 11.6h.05'],
};

/** An inline SVG icon in the ink colour. Decorative (aria-hidden) unless a label is given. */
export function iconSvg(name: IconName, label?: string): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('class', `ui-ic ui-ic-${name}`);
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
  } else s.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

type Kid = Node | string | null | false | undefined;

function span(cls: string, ...kids: Kid[]): HTMLSpanElement {
  const e = document.createElement('span');
  e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/** Give any element the shared tooltip (hover or focus, 150 ms). Plain text, at most two short lines. */
export function tip<E extends Element>(e: E, text: string): E {
  e.setAttribute('data-tip', text);
  return e;
}

/**
 * An icon that names itself: the glyph, its aria-label and the tooltip with its one word (or a short line). Focusable,
 * so a keyboard reaches the tooltip too.
 */
export function icon(name: IconName, label: string, tipText: string = label, focusable = true): HTMLSpanElement {
  const s = span(`ui-icon ui-icon-${name}`, iconSvg(name));
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', label);
  if (focusable) s.tabIndex = 0;
  return tip(s, tipText);
}

/**
 * A chip: an icon, a number with its unit (R1: a number keeps its unit word), at most two words, and the full sentence
 * in the tooltip.
 */
export function chip(name: IconName, text: string, tipText: string, cls = '', focusable = true): HTMLSpanElement {
  const s = span(`ui-chip${cls ? ` ${cls}` : ''}`, iconSvg(name), span('ui-chip-text', text));
  s.setAttribute('aria-label', tipText);
  if (focusable) s.tabIndex = 0;
  return tip(s, tipText);
}

export interface Note {
  /** The note panel's title (the inspector's kicker is "About"). */
  title: string;
  /** The full text that used to sit on the screen: one paragraph per entry. */
  body: (string | Node)[];
}

/**
 * The (i): a small ink circle-i, 16 px inside a 44 px hit area. Hover or focus shows the tooltip after 150 ms; a click
 * (or a second tap on touch) opens the note panel with the full text.
 */
export function info(label: string, tipText: string, note?: Note): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ui-info';
  b.setAttribute('aria-label', label);
  b.setAttribute('role', 'button');
  b.append(iconSvg('info'));
  tip(b, tipText);
  const full: Note = note ?? { title: label, body: [tipText] };
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    // A touch tap shows the tooltip first; the second tap on the same (i) opens the note.
    if (lastPointer === 'touch' && shownFor !== b) {
      show(b);
      return;
    }
    hide();
    openNote(full, b);
  });
  return b;
}

// ------------------------------------------------------------------ the shared tooltip

let tipEl: HTMLDivElement | null = null;
let shownFor: Element | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPointer = 'mouse';
let wired = false;

function tipNode(): HTMLDivElement {
  if (tipEl && tipEl.isConnected) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'ui-tip';
  tipEl.id = 'ui-tip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.hidden = true;
  document.body.append(tipEl);
  return tipEl;
}

/** Show the tooltip for `target` now, placed below it (above when there is no room), clamped inside the viewport. */
export function show(target: Element): void {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  const t = tipNode();
  t.textContent = text;
  t.hidden = false;
  shownFor = target;
  target.setAttribute('aria-describedby', 'ui-tip');
  const r = target.getBoundingClientRect();
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const m = 8;
  let x = r.left + r.width / 2 - w / 2;
  x = Math.max(m, Math.min(x, vw - w - m));
  let y = r.bottom + 6;
  if (y + h > vh - m) y = r.top - h - 6;
  y = Math.max(m, Math.min(y, vh - h - m));
  t.style.left = `${Math.round(x)}px`;
  t.style.top = `${Math.round(y)}px`;
}

export function hide(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (shownFor) shownFor.removeAttribute('aria-describedby');
  shownFor = null;
  if (tipEl) tipEl.hidden = true;
}

function tipTarget(n: EventTarget | null): Element | null {
  return n instanceof Element ? n.closest('[data-tip]') : null;
}

function later(target: Element): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (target.isConnected) show(target);
  }, 150);
}

/** Wire the document once: hover and focus show, leaving and Escape hide, a touch tap toggles. */
export function wireTips(): void {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPointer = e.pointerType || 'mouse';
      if (e.pointerType !== 'touch') return;
      const t = tipTarget(e.target);
      if (!t) return hide();
      if (t.classList.contains('ui-info')) return; // the (i) handles its own taps
      if (shownFor === t) hide();
      else show(t);
    },
    true,
  );
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = tipTarget(e.target);
    if (t && t !== shownFor) later(t);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    const t = tipTarget(e.target);
    if (t && !t.contains(e.relatedTarget as Node | null)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const t = tipTarget(e.target);
    if (t) later(t);
    else hide();
  });
  document.addEventListener('focusout', () => hide());
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (noteEl) {
        e.stopPropagation();
        closeNote();
      } else if (shownFor) hide();
    },
    true,
  );
  window.addEventListener('scroll', () => hide(), true);
  window.addEventListener('resize', () => hide());
}

// ------------------------------------------------------------------ the note panel (the inspector's look)

let noteEl: HTMLElement | null = null;
let noteFrom: HTMLElement | null = null;

/** Open the full text in a panel styled as the inspector: paper, ink, a rule, a close button. Escape closes it. */
export function openNote(n: Note, from?: HTMLElement): HTMLElement {
  closeNote();
  const root = document.createElement('aside');
  root.className = 'ui-note';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', `About: ${n.title}`);
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ui-note-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeNote();
  });
  const bar = span('ui-note-bar', span('ui-note-kicker', 'About'), close);
  const h = document.createElement('h2');
  h.className = 'ui-note-title';
  h.textContent = n.title;
  const body = document.createElement('div');
  body.className = 'ui-note-body';
  for (const b of n.body) {
    if (typeof b === 'string') {
      const p = document.createElement('p');
      p.textContent = b;
      body.append(p);
    } else body.append(b);
  }
  root.append(bar, h, body);
  document.body.append(root);
  noteEl = root;
  noteFrom = from ?? null;
  close.focus({ preventScroll: true });
  return root;
}

export function closeNote(): void {
  if (!noteEl) return;
  noteEl.remove();
  noteEl = null;
  const f = noteFrom;
  noteFrom = null;
  if (f?.isConnected) f.focus({ preventScroll: true });
}

/** The open note's text, or null (tests read it). */
export function noteText(): string | null {
  return noteEl ? noteEl.textContent : null;
}

if (typeof document !== 'undefined') wireTips();
