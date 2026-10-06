// Owner: room/rig. The beast (§4, §0a.22): one rig logic for every skin. Body plate, one head sprite per skin at a fixed
// scale, five sockets, SVG necks under the body (their lower ends hide behind it), one shared ground shadow, CSS/SVG
// state treatments. A head's state comes from HeadView.state only; it folds below its socket only when bound.
import type { BeastView, DropBinder, HeadGlow, HeadState, HeadView, RoomPhase, UiView } from '../contract';
import { agentName, el, sigil, svg } from './dom';
import { packTags, ringsText, shortDate, type HeadCue, type TagPlacement } from './logic';
import { animate, cue } from './motion';
import { neckShape } from './ribbon';
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

/** The wrap: paper strips over the head's silhouette (the sprite masks the overlay). */
function wrapOverlay(src: string): HTMLElement {
  const w = el('div', 'pl-room-wrap');
  w.style.setProperty('-webkit-mask-image', `url("${src}")`);
  w.style.setProperty('mask-image', `url("${src}")`);
  const s = svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  for (let i = -2; i < 9; i++) s.append(svg('line', { x1: i * 14 - 10, y1: 0, x2: i * 14 + 30, y2: 100, stroke: '#41291F', 'stroke-width': 0.9, opacity: 0.45 }));
  w.append(s);
  return w;
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

/** The full tag strip (agent sigil, project chip, date): each part its own ≥ 44 px hit region. */
function tagStrip(h: HeadView, t: TagPlacement, onHead: (id: string) => void): HTMLElement {
  const strip = el('div', `pl-room-tag is-${t.mode}`);
  strip.style.left = `${t.x}px`;
  strip.style.top = `${t.y}px`;
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
  if (t.mode === 'compact') {
    const d = shortDate(h.tag.date);
    strip.append(part('is-compact', `${agent}${h.tag.project ? ` · ${h.tag.project}` : ''}${h.tag.date ? ` · ${h.tag.date}` : ''}: read this receipt`, sigil(h.tag.agent, 14), d ? el('span', 'pl-room-tagdate', d) : null));
  } else {
    strip.append(part('is-agent', `Agent: ${agent}`, sigil(h.tag.agent, 14), agent));
    if (h.tag.project) strip.append(part('is-project', `Project: ${h.tag.project}`, h.tag.project));
    if (h.tag.date) strip.append(part('is-date', `Date: ${h.tag.date}`, shortDate(h.tag.date)));
  }
  if (h.rings && t.mode === 'full') strip.append(el('span', 'pl-room-tagrings', ringsText(h.rings)));
  return strip;
}

/** Full strip width: sigil+name, project chip, date, each ≥ 44 px, 8 px apart (text widths estimated at 12 px). */
function stripWidth(h: HeadView): number {
  const txt = (s: string, mono = false) => Math.max(44, Math.round(s.length * (mono ? 7.3 : 7.2) + 22));
  const parts = [txt(agentName(h.tag.agent)) + 18, h.tag.project ? txt(h.tag.project) : 0, h.tag.date ? txt('09-23', true) : 0].filter((x) => x > 0);
  return parts.reduce((a, b) => a + b, 0) + 8 * (parts.length - 1);
}

function headLean(place: HeadPlace, cx: number): number {
  return place.at.x < cx - 4 ? 1 : place.at.x > cx + 4 ? -1 : 0;
}

/** The beast: body plate, heads in sockets with tags and rings, the "+N" knot, pips (§4, §0a.22). */
export function Beast(p: BeastProps): HTMLElement {
  const rig: Rig = RIGS[p.beast.skin];
  const heads = p.beast.heads.filter((h) => h.socket !== null);
  const place = fitRig(rig, heads.map((h) => h.socket!), p.height);
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
  inner.append(sh);

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
  const tagReqs: { caseId: string; x: number; y: number; fullW: number }[] = [];
  const order = [...place.heads].sort((a, b) => b.socket - a.socket); // anchor (socket 0) painted last, on top
  for (const hp of order) {
    const h = bySocket.get(hp.socket)!;
    const g = p.glow.get(h.caseId);
    const change = stateChange(h.caseId, h.state);
    const fold = cues?.fold.get(h.caseId);
    const strike = cues?.strike.get(h.caseId);
    const lean = headLean(hp, cx);

    // Neck (paper ribbon or lantern string) from the socket to the head's collar.
    const neckG = svg('g', { class: 'pl-room-neck-g' });
    if (rig.neck === 'string') {
      neckG.append(svg('path', { class: 'pl-room-string', d: `M${hp.from.x} ${hp.from.y} L${hp.at.x} ${hp.at.y}` }));
    } else if (rig.neck === 'ribbon') {
      const n = neckShape(hp.from, hp.at, hp.w0, hp.w1, h.rings ? Math.min(h.rings.count, 8) : 0);
      neckG.append(svg('path', { class: 'pl-room-neck', d: n.front }));
      if (n.back) neckG.append(svg('path', { class: 'pl-room-neck-back', d: n.back }));
      for (const r of n.rings) neckG.append(svg('line', { class: 'pl-room-neck-ring', x1: r[0], y1: r[1], x2: r[2], y2: r[3] }));
    }
    const folded = h.state === 'bound' || h.state === 'sunk' || h.state === 'heron';
    if (folded) {
      neckG.setAttribute('opacity', '0');
      if (!still && fold && h.state === 'bound') {
        neckG.removeAttribute('opacity');
        const c = cue(fold.key, 520, fold.offset);
        if (c.play) animate(neckG, 'is-folding', c);
        else neckG.setAttribute('opacity', '0');
      }
    }
    necks.append(neckG);

    // The head.
    const box = el('div', `pl-room-head is-${h.state}${g?.glow ? ' is-glow' : ''}${h.caseId === cues?.focused ? ' is-focused' : ''}`);
    Object.assign(box.style, { left: `${hp.box.x}px`, top: `${hp.box.y}px`, width: `${hp.box.w}px`, height: `${hp.box.h}px`, zIndex: String(10 - hp.socket) });
    box.style.setProperty('--ax', `${rig.headAnchor[0] * 100}%`);
    box.style.setProperty('--ay', `${rig.headAnchor[1] * 100}%`);
    // Folding goes from the head point to just below the socket.
    box.style.setProperty('--fx', `${Math.round(hp.from.x - hp.at.x)}px`);
    box.style.setProperty('--fy', `${Math.round(hp.from.y - hp.at.y + Math.max(4, hp.w0 * 0.3))}px`);
    box.style.setProperty('--bow', `${lean * 10}deg`);
    box.style.setProperty('--lean', `${lean * -7}deg`);
    box.dataset.case = h.caseId;
    if (rig.head) {
      const img = el('img', 'pl-room-head-img');
      img.src = rig.head;
      img.alt = '';
      img.draggable = false;
      box.append(img);
      if (h.state === 'wrapped') {
        box.append(wrapOverlay(rig.head));
      } else if (change && change.from === 'wrapped' && h.state === 'bared' && !still) {
        const w = wrapOverlay(rig.head);
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
    // lean in / turn aside while dragging. Every one ends in the static state the classes above describe.
    if (!still) {
      if (h.state === 'bound' && fold) animate(box, 'is-folding', cue(fold.key, 520, fold.offset));
      else if (h.state === 'bound' && change && !fold) animate(box, 'is-folding', cue(`fold:${change.key}`, 520));
      if (h.state === 'heron' && change) {
        if (rig.body === null) animate(inner, 'is-flying', cue(`fly:${change.key}`, 1100));
        else animate(box, 'is-flying', cue(`fly:${change.key}`, 1100));
      }
      if (h.state === 'sunk' && change) animate(box, 'is-sinking', cue(`sinkhead:${change.key}`, 600));
      if (strike) animate(box, 'is-striking', cue(strike.key, 160, strike.offset));
      if (hp.socket === 0 && cues && p.beat === 'rise' && h.state === 'wrapped') animate(box, 'is-anchor-lean', cue(`anchor:${cues.roomKey}`, 900, 500));
    }
    if (h.state === 'heron') box.classList.add('is-heron-gone');
    if (g && !folded && h.state !== 'lantern') {
      box.classList.add(g.glow ? 'is-lean' : 'is-aside');
      box.style.setProperty('--lean', `${g.glow ? lean * -6 : lean * 9}deg`);
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
      if (animate(page, 'is-tearing', cue(`page:${strike.key}`, 640, strike.offset + 120))) inner.append(page);
    }

    if (!folded) tagReqs.push({ caseId: h.caseId, x: hp.at.x, y: hp.at.y + 6, fullW: stripWidth(h) });
  }

  // Tags: full strips when every strip fits, else compact knobs (the slip carries the current head's full tag).
  const tags = packTags(
    [...tagReqs].sort((a, b) => (bySocketOf(heads, a.caseId) ?? 9) - (bySocketOf(heads, b.caseId) ?? 9)),
    { bounds: { w: place.w, h: place.h } },
  );
  for (const t of tags) root.append(tagStrip(heads.find((h) => h.caseId === t.caseId)!, t, p.onHead));

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
    const right = Math.max(...place.heads.map((x) => x.box.x + x.box.w), place.w * 0.7);
    Object.assign(k.style, { left: `${Math.min(place.w - 120, right - 30)}px`, top: `${Math.round(place.h * 0.38)}px` });
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
