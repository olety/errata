// Owner: cards/layout. The Table (play-loop §1, §0a.17–19): header, stage, wood and status bands at the exact heights
// layout() computed, over the painted world plate whose table edge lands on the shore line.
// Import from ../contract only. Never the adapter or the engine.
import type { Bands } from '../contract';
import { asset, el } from '../cards/dom';
import { placePlate, PLATES } from './geom';
import './layout.css';

export interface TableProps {
  bands: Bands;
  header: HTMLElement;
  /** The creature stage (sky + creature), or the campfire's focused pair, or the boss lake. */
  stage: HTMLElement;
  wood: HTMLElement;
  status: HTMLElement;
}

/** The band boxes in page pixels: header, stage (sky + creature, down to the shore), wood, status. Never overlapping. */
export function tableBoxes(b: Bands): { header: { y: number; h: number }; stage: { y: number; h: number }; wood: { y: number; h: number }; status: { y: number; h: number }; height: number } {
  const stageY = b.header.y + b.header.h;
  return {
    header: { y: b.header.y, h: b.header.h },
    stage: { y: stageY, h: b.shoreY - stageY },
    wood: { y: b.wood.y, h: b.wood.h },
    status: { y: b.status.y, h: b.status.h },
    height: b.status.y + b.status.h,
  };
}

/** The Table layout: header, stage, wood and status bands at the heights layout() computed (§1, §0a.17). */
export function Table(p: TableProps): HTMLElement {
  const b = p.bands;
  const box = tableBoxes(b);
  const root = el('div', `pl-layout-table pl-layout-${b.mode}${b.scroll ? ' is-scroll' : ''}`);
  root.dataset.mode = b.mode;
  root.style.setProperty('--pl-layout-group-gap', `${b.groupGap / 2}px`);
  root.style.setProperty('--pl-layout-margin', `${b.margin / 2}px`);
  root.style.setProperty('--pl-layout-books-w', `${b.books.w}px`);
  root.style.setProperty('--pl-layout-piles-w', `${b.piles.w}px`);
  root.style.setProperty('--pl-layout-books-gap', `${b.books.gap}px`);
  root.style.setProperty('--pl-layout-piles-gap', `${b.piles.gap}px`);
  root.style.setProperty('--pl-layout-card-gap', `${b.cards.gap}px`);
  root.style.setProperty('--pl-layout-touch', `${b.touch.min}px`);

  const canvas = el('div', 'pl-layout-canvas');
  canvas.style.height = `${box.height}px`;
  canvas.append(World(b, box.height));

  const band = (cls: string, y: number, h: number, child: HTMLElement) => {
    const e = el('div', `pl-layout-band ${cls}`, child);
    e.style.top = `${y}px`;
    e.style.height = `${h}px`;
    return e;
  };
  canvas.append(band('pl-layout-stage', box.stage.y, box.stage.h, p.stage), band('pl-layout-wood', box.wood.y, box.wood.h, p.wood), band('pl-layout-header', box.header.y, box.header.h, p.header), band('pl-layout-status', box.status.y, box.status.h, p.status));
  root.append(canvas);
  return root;
}

/** The painted world: the raised plate (portrait on phones) with its table edge on the shore, the wood extended below. */
function World(b: Bands, height: number): HTMLElement {
  const plate = b.mode === 'phone' ? PLATES.portrait : PLATES.raised;
  const at = placePlate(plate, b.viewport.w, b.shoreY, height);
  const world = el('div', 'pl-layout-world');
  world.setAttribute('aria-hidden', 'true');
  const url = asset(plate.src);
  const img = el('img', 'pl-layout-plate');
  img.src = url;
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  Object.assign(img.style, { left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, height: `${at.height}px` });
  world.append(img);
  for (const x of at.ext) {
    const e = el('div', `pl-layout-woodband${x.flip ? ' is-flip' : ''}`);
    Object.assign(e.style, { top: `${x.top}px`, height: `${x.height}px`, backgroundImage: `url("${url}")`, backgroundSize: `${at.width}px ${at.height}px`, backgroundPosition: `${at.left}px ${x.bgTop}px` });
    world.append(e);
  }
  return world;
}
