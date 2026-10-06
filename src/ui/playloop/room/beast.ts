// Owner: room/rig. The beast (§4, §0a.22): one rig logic for every skin. Body plate, one head sprite per skin at a fixed
// scale, five sockets, SVG necks under the body (their lower ends hide behind it), one shared ground shadow, CSS/SVG
// state treatments. A head's state comes from HeadView.state only; it folds below its socket only when bound.
import type { BeastView, DropBinder, HeadGlow, HeadState, HeadView, RoomPhase, UiView } from '../contract';
import { agentName, el, sigil, svg } from './dom';
import { packTags, ringsText, shortDate, type HeadCue, type TagPlacement, type TagRequest } from './logic';
import { animate, cue } from './motion';
import { foldFrames, foldRest, neckShape, type NeckShape } from './ribbon';
import { RIGS, fitRig, type HeadPlace, type Rig } from './rig';
import './room.css';

/** Animation cues the room screen computes from the result and the last effect (optional: without them, no motion). */
export interface BeastCues {
  /** Heads to fold, from PlayResultView.bound (date order) or ui.effect.bound, keyed by result or effect id. */
  fold: ReadonlyMap<string, HeadCue>;
  /** Standing heads that strike once while the beat is strike. */
  strike: ReadonlyMap<string, HeadCue>;
  roomKey: string;
  phase: RoomPhase;
  /** The current drag (card and target) so the lean replays only when it changes. */
  leanTo: string | null;
  /** The clear: the boat only when pips.fully; a sink when standing heads remain. */
  clear: 'boat' | 'sink' | null;
  resultId: number | null;
  /** The head whose receipt is on the slip. */
  focused: string | null;
}

export interface BeastProps {
  beast: BeastView;
  /** Per-head glow and one word while dragging (from ui.drag.preview.heads). */
  glow: ReadonlyMap<string, HeadGlow>;
  beat: UiView['beat'];
  reducedMotion: boolean;
  /** The creature band's height; the feet stand on its bottom edge (bands.shoreY). */
  height: number;
  /** Optional: the arena's width, so a wide beast (the moth) never overflows a narrow screen. */
  width?: number;
  drag: DropBinder;
  onHead(caseId: string): void;
  /** Optional animation cues from the room screen (results and effects, once per id). */
  cues?: BeastCues;
}

// Per-head state memory across repaints: a head that changes state between paints plays that change once.
const lastState = new Map<string, HeadState>();
const transition = new Map<string, { key: string; from: HeadState; to: HeadState }>();
let transitionSeq = 0;

function stateChange(caseId: string, now: HeadState): { key: string; from: HeadState; to: HeadState } | null {
  const prev = lastState.get(caseId);
  lastState.set(caseId, now);
  if (prev !== undefined && prev !== now) {
    const t = { key: `state:${caseId}:${++transitionSeq}`, from: prev, to: now };
    transition.set(caseId, t);
    return t;
  }
  const t = transition.get(caseId);
  return t && t.to === now ? t : null;
}

const STATE_WORD: Record<HeadState, string> = {
  wrapped: 'not yet reviewed',
  bared: 'a problem',
  bound: 'addressed',
  standing: 'a problem left open',
  heron: 'a change of plan',
  sunk: 'not a problem',
  lantern: 'a verified session',
};

/** The wrap: paper strips over the head's silhouette (the sprite masks the overlay); strips every 13 px at any size. */
function wrapOverlay(src: string, w: number, h: number): HTMLElement {
  const box = el('div', 'pl-room-wrap');
  box.style.setProperty('-webkit-mask-image', `url("${src}")`);
  box.style.setProperty('mask-image', `url("${src}")`);
  const s = svg('svg', { viewBox: `0 0 ${Math.round(w)} ${Math.round(h)}`, 'aria-hidden': 'true' });
  const step = 13;
  const run = h * 0.42;
  for (let x = -run; x < w + step; x += step) s.append(svg('line', { x1: Math.round(x), y1: 0, x2: Math.round(x + run), y2: Math.round(h), stroke: '#41291F', 'stroke-width': 1, opacity: 0.4 }));
  box.append(s);
  return box;
}

/** A paper lantern for the Workshop: brass cap, paper body, ink ribs. Static; it never glows. */
function lantern(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 62 100', class: 'pl-room-lantern', 'aria-hidden': 'true' });
  s.append(
    svg('rect', { x: 24, y: 0, width: 14, height: 10, rx: 2, fill: '#B08A3E', stroke: '#41291F', 'stroke-width': 1.5 }),
    svg('ellipse', { cx: 31, cy: 52, rx: 26, ry: 38, fill: '#F3E7D1', stroke: '#41291F', 'stroke-width': 2 }),
    svg('path', { d: 'M31 14 C 14 30, 14 74, 31 90 M31 14 C 48 30, 48 74, 31 90 M31 14 V90', fill: 'none', stroke: '#41291F', 'stroke-width': 1.2, opacity: 0.6 }),
    svg('ellipse', { cx: 31, cy: 56, rx: 7, ry: 11, fill: '#B08A3E', opacity: 0.85 }),
    svg('rect', { x: 24, y: 88, width: 14, height: 8, rx: 2, fill: '#B08A3E', stroke: '#41291F', 'stroke-width': 1.5 }),
  );
  return s;
}

/** The paper boat (§2 step 6). */
function boat(w: number): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 120 60', width: w, height: w / 2, class: 'pl-room-boat', 'aria-hidden': 'true' });
  s.append(svg('path', { d: 'M4 30 L116 30 L96 54 L24 54 Z' }), svg('path', { d: 'M30 30 L60 4 L90 30 Z' }), svg('path', { d: 'M60 4 L60 30', fill: 'none' }));
  return s;
}

/** The tag (agent sigil, project chip, date): each part its own ≥ 44 px hit region; rings said under the date. */
function tagStrip(h: HeadView, t: TagPlacement, onHead: (id: string) => void): HTMLElement {
  const strip = el('div', `pl-room-tag is-${t.mode}`);
  Object.assign(strip.style, { left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px` });
  const part = (cls: string, aria: string, ...kids: (Node | string | null)[]) => {
    const b = el('button', `pl-room-tagpart ${cls}`, el('span', '', ...kids));
    b.type = 'button';
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onHead(h.caseId);
    });
    return b;
  };
  const agent = agentName(h.tag.agent);
  const d = shortDate(h.tag.date);
  const row = (...parts: HTMLElement[]) => el('div', 'pl-room-tagrow', ...parts);
  if (t.mode === 'compact') {
    strip.append(row(part('is-compact', `${agent}${h.tag.project ? ` · ${h.tag.project}` : ''}${h.tag.date ? ` · ${h.tag.date}` : ''}${h.rings ? ` · ${ringsText(h.rings)}` : ''}: read this receipt`, sigil(h.tag.agent, 14), d ? el('span', 'pl-room-tagdate', d) : null)));
    return strip;
  }
  const first = [part('is-agent', `Agent: ${agent}`, sigil(h.tag.agent, 16))];
  if (h.tag.date || h.rings) {
    first.push(
      part(
        'is-date',
        `${h.tag.date ? `Date: ${h.tag.date}` : 'No date'}${h.rings ? ` · ${ringsText(h.rings)}` : ''}`,
        d ? el('span', 'pl-room-tagdate', d) : null,
        h.rings ? el('span', 'pl-room-tagrings', ringsText(h.rings)) : null,
      ),
    );
  }
  const project = h.tag.project ? part('is-project', `Project: ${h.tag.project}`, h.tag.project) : null;
  if (t.mode === 'stacked' && project) strip.append(row(...first), row(project));
  else strip.append(row(...first, ...(project ? [project] : [])));
  return strip;
}

const textW = (s: string, px: number) => Math.round(s.length * px * 0.6 + 18);

/** One-row strip width: sigil, date (with rings text), project chip; each ≥ 44 px, 8 px apart. */
function tagSizes(h: HeadView): { fullW: number; stackW: number; stackH: number } {
  const dateW = Math.max(44, textW('09-23', 12), h.rings ? textW(ringsText(h.rings), 10) : 0);
  const projW = h.tag.project ? Math.max(44, textW(h.tag.project, 12)) : 0;
  const row1 = 44 + (h.tag.date || h.rings ? 8 + dateW : 0);
  const fullW = row1 + (projW ? 8 + projW : 0);
  return { fullW, stackW: Math.max(row1, projW), stackH: projW ? 96 : 44 };
}

/** The head's side of the beast: −1 left of centre, +1 right, 0 on the axis (Astra's `side`). */
function headSide(place: HeadPlace, cx: number): number {
  return place.at.x < cx - 4 ? -1 : place.at.x > cx + 4 ? 1 : 0;
}

/** Where a head's tag hangs from: its collar, or a lantern's bottom ring. */
function tagPoint(hp: HeadPlace): { x: number; y: number } {
  return { x: hp.at.x, y: Math.max(hp.at.y, hp.box.y + hp.box.h * 0.95) };
}

let styleSeq = 0;
const fmt = (n: number) => Math.round(n * 10) / 10;

/** Per-head fold keyframes (the head runs back down its own neck; the neck shortens along the same curve). */
function foldKeyframes(n: NeckShape, headH: number, anchorY: number, side: number): { css: string; head: string; neck: string } {
  const id = ++styleSeq;
  const frames = foldFrames(n, headH, anchorY, side);
  const head = `pl-room-fold-h${id}`;
  const neck = `pl-room-fold-n${id}`;
  const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;
  const css =
    `@keyframes ${head}{${frames.map((k) => `${pct(k.f)}{transform:translate(${k.dx}px,${k.dy}px) rotate(${k.bow}deg) scaleY(${k.sy})}`).join('')}}` +
    `@keyframes ${neck}{${frames.map((k) => `${pct(k.f)}{d:path("${k.neck}")}`).join('')}}`;
  return { css, head, neck };
}

/** The beast: body plate, heads in sockets with tags and rings, the "+N" knot, pips (§4, §0a.22). */
export function Beast(p: BeastProps): HTMLElement {
  const rig: Rig = RIGS[p.beast.skin];
  const heads = p.beast.heads.filter((h) => h.socket !== null);
  const place = fitRig(rig, heads.map((h) => h.socket!), p.height, p.width);
  const cues = p.cues;
  const still = p.reducedMotion;
  const root = el('div', `pl-room-beast is-${p.beast.skin}`);
  root.style.width = `${place.w}px`;
  root.style.height = `${place.h}px`;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', `${p.beast.name}: ${p.beast.pips.text}`);
  const inner = el('div', 'pl-room-beast-inner');
  root.append(inner);
  const cx = place.w / 2;

  // Rise once per room; the clear (boat or sink) once per result.
  if (!still && cues) {
    if (cues.clear === null) animate(inner, 'is-rise', cue(`rise:${cues.roomKey}`, 700));
  }
  if (cues?.clear === 'sink') {
    inner.classList.add('is-sink');
    if (!still) animate(inner, 'is-sinking', cue(`sink:${cues.roomKey}:${cues.resultId}`, 900, 300));
  }

  // The one shared ground shadow.
  const sh = el('div', 'pl-room-shadow');
  Object.assign(sh.style, { left: `${place.shadow.x}px`, top: `${place.shadow.y}px`, width: `${place.shadow.w}px`, height: `${place.shadow.h}px` });
  // The shadow stays on the shore (a flying heron leaves it; a sinking beast keeps it).
  root.append(sh);

  // Necks: one SVG under the body, so each neck's lower end hides behind the plate. No ribbons under reduced motion
  // for the drag; necks themselves are the rig and stay.
  const necks = svg('svg', { class: 'pl-room-necks', width: place.w, height: place.h, viewBox: `0 0 ${place.w} ${place.h}`, 'aria-hidden': 'true' });
  inner.append(necks);
  if (rig.body) {
    const body = el('img', 'pl-room-body');
    body.src = rig.body;
    body.alt = '';
    body.draggable = false;
    if (place.body) Object.assign(body.style, { left: `${place.body.x}px`, top: `${place.body.y}px`, width: `${place.body.w}px`, height: `${place.body.h}px` });
    inner.append(body);
  }
  // The body is the beast target (the Workshop's bench too): its opaque box.
  const bodyHit = el('div', 'pl-room-bodyhit');
  const bb = place.body
    ? { x: place.body.x + rig.bodyBox.x0 * place.body.w, y: place.body.y + rig.bodyBox.y0 * place.body.h, w: (rig.bodyBox.x1 - rig.bodyBox.x0) * place.body.w, h: (rig.bodyBox.y1 - rig.bodyBox.y0) * place.body.h }
    : { x: 0, y: 0, w: place.w, h: place.h };
  Object.assign(bodyHit.style, { left: `${bb.x}px`, top: `${bb.y}px`, width: `${Math.max(44, bb.w)}px`, height: `${Math.max(44, bb.h)}px` });
  inner.append(bodyHit);
  p.drag.bindTarget(`beast:${p.beast.roomKey}`, { kind: 'beast' }, bodyHit);

  const bySocket = new Map(heads.map((h) => [h.socket!, h]));
  const tagReqs: TagRequest[] = [];
  const order = [...place.heads].sort((a, b) => b.socket - a.socket); // anchor (socket 0) painted last, on top
  for (const hp of order) {
    const h = bySocket.get(hp.socket)!;
    const g = p.glow.get(h.caseId);
    const change = stateChange(h.caseId, h.state);
    const fold = cues?.fold.get(h.caseId);
    const strike = cues?.strike.get(h.caseId);
    const side = headSide(hp, cx);
    const q = Math.max(0.6, Math.min(1.3, hp.box.h / 100));
    let flying = false;
    // Under reduced motion nothing folds, sinks or flies: the head keeps its neck and tag and wears a static icon.
    const folded = !still && (h.state === 'bound' || h.state === 'sunk' || h.state === 'heron');
    const foldCue = !still && h.state === 'bound' ? (fold ? cue(fold.key, 440, fold.offset) : change ? cue(`fold:${change.key}`, 440) : null) : null;

    // Neck (paper ribbon or lantern string) from the socket to the head's collar, painted paper, back face, rings,
    // then the ink outline (Astra §1). A folded head's neck is gone; a folding one shortens along its own curve.
    const neckG = svg('g', { class: 'pl-room-neck-g' });
    let shape: NeckShape | null = null;
    if (rig.neck === 'string') {
      if (!folded) neckG.append(svg('path', { class: 'pl-room-string', d: `M${fmt(hp.from.x)} ${fmt(hp.from.y)} L${fmt(hp.at.x)} ${fmt(hp.at.y)}` }));
    } else if (rig.neck === 'ribbon') {
      shape = neckShape(hp.from, hp.at, hp.w0, hp.w1, h.rings ? h.rings.count : 0, { anchor: hp.socket === 0, band: Math.max(2, hp.w1 * 0.14) });
      if (!folded) {
        neckG.append(svg('path', { class: 'pl-room-neck', d: shape.front }));
        if (shape.back) neckG.append(svg('path', { class: 'pl-room-neck-back', d: shape.back }));
        for (const r of shape.rings) neckG.append(svg('path', { class: 'pl-room-neck-ring', d: r }));
        neckG.append(svg('path', { class: 'pl-room-neck-line', d: shape.front }));
      }
    }
    necks.append(neckG);

    // The head.
    const box = el('div', `pl-room-head is-${h.state}${g?.glow ? ' is-glow' : ''}${h.caseId === cues?.focused ? ' is-focused' : ''}`);
    Object.assign(box.style, { left: `${hp.box.x}px`, top: `${hp.box.y}px`, width: `${hp.box.w}px`, height: `${hp.box.h}px`, zIndex: String(10 - hp.socket) });
    box.style.setProperty('--ax', `${rig.headAnchor[0] * 100}%`);
    box.style.setProperty('--ay', `${rig.headAnchor[1] * 100}%`);
    // Bound: the flattened remnant rests just below the socket (Astra §3). Sunk: lowered onto the socket.
    const rest = shape ? foldRest(shape, hp.box.h, rig.headAnchor[1], side) : { dx: hp.from.x - hp.at.x, dy: hp.from.y - hp.at.y };
    box.style.setProperty('--fx', `${fmt(rest.dx)}px`);
    box.style.setProperty('--fy', `${fmt(rest.dy)}px`);
    box.style.setProperty('--sx', `${fmt(hp.from.x - hp.at.x)}px`);
    box.style.setProperty('--sy', `${fmt(hp.from.y - hp.at.y)}px`);
    box.dataset.case = h.caseId;
    if (rig.head) {
      const img = el('img', 'pl-room-head-img');
      img.src = rig.head;
      img.alt = '';
      img.draggable = false;
      box.append(img);
      if (h.state === 'wrapped') {
        box.append(wrapOverlay(rig.head, hp.box.w, hp.box.h));
      } else if (change && change.from === 'wrapped' && h.state === 'bared' && !still) {
        const w = wrapOverlay(rig.head, hp.box.w, hp.box.h);
        if (animate(w, 'is-tearing', cue(`tear:${change.key}`, 360))) box.append(w);
      }
    } else {
      box.append(lantern());
    }
    if (h.state === 'bound') box.append(el('span', 'pl-room-muzzle'));
    if (still && (h.state === 'bound' || h.state === 'sunk' || h.state === 'heron' || h.state === 'standing' || h.state === 'wrapped')) {
      const icon = { bound: '✓', sunk: '–', heron: '↗', standing: '!', wrapped: '?' }[h.state as 'bound'];
      box.append(el('span', 'pl-room-icon', icon));
    }

    // Motion: fold (bound), fly off (a change of plan), sink (not a problem), strike, the anchor's lean at the rise,
    // lean in / turn aside while dragging. Every one ends in the static state the classes describe.
    if (foldCue?.play && shape) {
      const k = foldKeyframes(shape, hp.box.h, rig.headAnchor[1], side);
      const st = document.createElement('style');
      st.textContent = k.css;
      root.append(st);
      box.style.animation = `${k.head} 440ms linear ${foldCue.delay}ms both`;
      const line = svg('path', { class: 'pl-room-neck', d: shape.front });
      const outline = svg('path', { class: 'pl-room-neck-line', d: shape.front });
      for (const e of [line, outline]) e.style.animation = `${k.neck} 440ms linear ${foldCue.delay}ms both`;
      neckG.append(line, outline);
    } else if (foldCue?.play) {
      animate(box, 'is-folding', foldCue);
    }
    if (!still) {
      if (h.state === 'heron' && change) {
        if (rig.body === null) {
          const c = cue(`fly:${change.key}`, 1100);
          flying = animate(inner, 'is-flying', c);
          animate(sh, 'is-fading', c);
        } else animate(box, 'is-flying', cue(`fly:${change.key}`, 1100));
      }
      if (h.state === 'sunk' && change) animate(box, 'is-sinking', cue(`sinkhead:${change.key}`, 600));
      if (strike) animate(box, 'is-striking', cue(strike.key, 160, strike.offset));
      if (hp.socket === 0 && cues && p.beat === 'rise' && h.state === 'wrapped') {
        box.style.setProperty('--lean', `${side === 0 ? -6 : -8 * side}deg`);
        animate(box, 'is-anchor-lean', cue(`anchor:${cues.roomKey}`, 900, 500));
      }
    }
    if (h.state === 'heron') {
      if (!flying) box.classList.add('is-heron-gone');
      // The bodiless heron (the Event) is the whole beast: once flown, the shore is empty but for one line.
      if (rig.body === null && !flying) {
        inner.classList.add('is-flown');
        sh.classList.add('is-flown');
        root.append(el('p', 'pl-room-heronline', 'A change of plan. The heron is listed at the end of the run.'));
      }
    }
    // While dragging (Astra §4): eligible heads lean in, −8°·side and (−3q·side, +3q); the others turn aside,
    // +11°·side and (+2q·side, −q), with the one word for their first failing check.
    if (g && !folded && h.state !== 'lantern') {
      const sd = side === 0 ? (hp.socket % 2 ? -1 : 1) : side;
      box.classList.add(g.glow ? 'is-lean' : 'is-aside');
      box.style.setProperty('--lean', `${g.glow ? -8 * sd : 11 * sd}deg`);
      box.style.setProperty('--lx', `${fmt(g.glow ? -3 * q * sd : 2 * q * sd)}px`);
      box.style.setProperty('--ly', `${fmt(g.glow ? 3 * q : -q)}px`);
      if (!still && cues?.leanTo) animate(box, 'is-leaning', cue(`lean:${cues.leanTo}:${h.caseId}`, 160, hp.socket === 0 ? 0 : 60));
    }
    if (g?.word) box.append(el('span', `pl-room-word${g.glow ? ' is-glow' : ''}`, g.word));

    // Hit region: the head's core box (≥ 44 px), a head drop target and the tap that reads its receipt.
    const hit = el('button', 'pl-room-hit');
    hit.type = 'button';
    const inset = folded ? 0.3 : 0.16;
    const hw = Math.max(44, hp.box.w * (1 - 2 * inset));
    const hh = Math.max(44, hp.box.h * (1 - 2 * inset));
    Object.assign(hit.style, { left: `${(hp.box.w - hw) / 2}px`, top: `${(hp.box.h - hh) / 2}px`, width: `${hw}px`, height: `${hh}px` });
    hit.setAttribute('aria-label', `${agentName(h.tag.agent)}${h.tag.project ? ` · ${h.tag.project}` : ''}${h.tag.date ? ` · ${h.tag.date}` : ''}: ${STATE_WORD[h.state]}${h.rings ? ` · ${ringsText(h.rings)}` : ''}`);
    hit.addEventListener('click', (e) => {
      e.stopPropagation();
      p.onHead(h.caseId);
    });
    box.append(hit);
    if (h.state !== 'lantern') p.drag.bindTarget(`head:${h.caseId}`, { kind: 'head', caseId: h.caseId }, hit);
    inner.append(box);

    // Torn page toward the Open pile (bottom right, where the piles lie on the wood).
    if (strike && !still) {
      const page = el('div', 'pl-room-page');
      Object.assign(page.style, { left: `${hp.at.x - 17}px`, top: `${hp.at.y - 22}px` });
      page.style.setProperty('--px', `${Math.round(place.w * 0.9 - hp.at.x + 160)}px`);
      page.style.setProperty('--py', `${Math.round(place.h - hp.at.y + 180)}px`);
      if (animate(page, 'is-tearing', cue(`page:${strike.key}`, 640, strike.offset + 120))) root.append(page);
    }

    if (!folded) tagReqs.push({ caseId: h.caseId, x: hp.at.x, y: tagPoint(hp).y + 6, ...tagSizes(h) });
  }

  // Tags: full strips when every strip fits, else compact knobs (the slip carries the current head's full tag).
  const standingUp = (st: HeadState) => still || (st !== 'bound' && st !== 'sunk' && st !== 'heron');
  const obstacles = place.heads.filter((hp) => standingUp(bySocket.get(hp.socket)!.state)).map((hp) => {
    const h = bySocket.get(hp.socket)!;
    return { owner: h.caseId, x: hp.box.x + hp.box.w * 0.22, y: hp.box.y + hp.box.h * 0.15, w: hp.box.w * 0.56, h: hp.box.h * 0.6 };
  });
  const tags = packTags(
    [...tagReqs].sort((a, b) => (bySocketOf(heads, a.caseId) ?? 9) - (bySocketOf(heads, b.caseId) ?? 9)),
    { bounds: { w: place.w, h: place.h }, obstacles },
  );
  // Each tag hangs on a thread from its head's collar, so a nudged tag still says whose it is.
  const ties = svg('svg', { class: 'pl-room-ties', width: place.w, height: place.h, viewBox: `0 0 ${place.w} ${place.h}`, 'aria-hidden': 'true' });
  for (const t of tags) {
    const hp = place.heads.find((x) => bySocket.get(x.socket)?.caseId === t.caseId)!;
    const from = tagPoint(hp);
    const tx = Math.min(Math.max(from.x, t.x + 12), t.x + t.w - 12);
    ties.append(svg('path', { d: `M${fmt(from.x)} ${fmt(from.y)} L${fmt(tx)} ${t.y + 10}`, class: 'pl-room-tie' }));
    inner.append(tagStrip(heads.find((h) => h.caseId === t.caseId)!, t, p.onHead));
  }
  inner.append(ties);

  // Pips on the crown: the lit pips are the view's one rose accent. Never "0/0": pips.text says it.
  const pips = el('div', 'pl-room-pips');
  const dots = el('span', 'pl-room-pipdots');
  for (let i = 0; i < Math.min(p.beast.pips.confirmed, 12); i++) dots.append(el('span', `pl-room-pip${i < p.beast.pips.addressed ? ' is-lit' : ''}`));
  if (p.beast.pips.confirmed > 0) pips.append(dots);
  pips.append(el('span', '', p.beast.pips.text));
  root.append(pips);

  // Overflow: "N more · a bound · u unreviewed", exactly.
  if (p.beast.overflow) {
    const k = el('button', 'pl-room-knot', p.beast.overflow.text);
    k.type = 'button';
    root.append(k);
  }

  // The clear: the boat only when pips.fully.
  if (cues?.clear === 'boat') {
    inner.classList.add('is-boat');
    if (!still) animate(inner, 'is-boating', cue(`boat:${cues.roomKey}:${cues.resultId}`, 700, 400 + 90 * (cues.fold.size + 1)));
    const bt = boat(Math.max(80, Math.round(place.w * 0.28)));
    Object.assign(bt.style, { left: `${Math.round(place.w / 2 - place.w * 0.14)}px`, top: `${Math.round(place.h - place.w * 0.14)}px` });
    if (!still) animate(bt, 'is-drifting', cue(`boat-drift:${cues.roomKey}:${cues.resultId}`, 1600, 600 + 90 * (cues.fold.size + 1)));
    root.append(bt);
  }
  return root;
}

function bySocketOf(heads: readonly HeadView[], caseId: string): number | null {
  return heads.find((h) => h.caseId === caseId)?.socket ?? null;
}
