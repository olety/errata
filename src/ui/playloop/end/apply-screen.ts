// Owner: boss/apply. Apply (play-loop §9, §0a.14): the books open to both diffs with context, Skill bodies first; the
// blockers with "Return to the final campfire"; folder grants; the seal; Reviewed, Fits and Written ink one by one, each
// only when its InkState is inked; Undo cracks the seal; the footer only after a verified write; and the end screen
// from the run summary. Presentation only: the engine's write protocol runs behind api.apply.

import './end.css';
import type { ApplyDiffView, ApplyView, ScreenProps } from '../contract';
import { COPY } from '../contract';
import { Books } from '../cards';
import { ART } from './art';
import { button, el, INERT, receipt, rich } from './dom';
import { applyMotion, applyPlan, diffRows, fmt, newApplyMemory, plateBox, summaryPlan, type ApplyPlan, type DiffRow } from './model';

/** Presentation memory across repaints (see applyMotion): the pane choice, each ink and the crack play once. */
const seen = newApplyMemory();

export function ApplyScreen(p: ScreenProps<ApplyView>): { stage: HTMLElement; wood: HTMLElement } {
  const v = p.view;
  const b = p.ui.bands;
  const plan = applyPlan(v);
  const { fresh, crack } = applyMotion(seen, v, p.ui.reducedMotion);

  // ---------------------------------------------------------------- the stage: the open books (diffs) and the run
  const plate = plateBox(b.viewport, b.shoreY);
  const stage = el('section', `pl-end-apply pl-end-${b.mode}`);
  stage.style.height = `${b.sky.h + b.creature.h}px`;
  paint(stage, plate, b.sky.y);

  const pane = seen.chosen ?? plan.pane;
  const diffsPane = el('div', 'pl-end-pane', diffsBody(v, plan));
  const runPane = el('div', 'pl-end-pane', runBody(v));
  diffsPane.hidden = pane !== 'diffs';
  runPane.hidden = pane !== 'run';
  const tabs = el('div', 'pl-end-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabFor = (which: 'diffs' | 'run', label: string) => {
    const t = button(label, `pl-end-tab${pane === which ? ' pl-end-on' : ''}`, () => {
      seen.chosen = which;
      diffsPane.hidden = which !== 'diffs';
      runPane.hidden = which !== 'run';
      for (const x of tabs.children) x.classList.toggle('pl-end-on', x === t);
    });
    t.setAttribute('role', 'tab');
    return t;
  };
  tabs.append(tabFor('diffs', 'The diffs'), tabFor('run', 'The run'));
  const sheet = el('div', 'pl-end-sheet', el('header', 'pl-end-sheethead', el('h2', 'pl-end-title', 'Apply'), tabs, plan.busyText ? el('span', 'pl-end-busy', plan.busyText) : null), diffsPane, runPane);
  stage.append(sheet);

  // ---------------------------------------------------------------- the wood: books, the seal and its stamps, blockers
  const wood = el('div', `pl-end-wood pl-end-applywood pl-end-${b.mode}`);
  wood.style.height = `${b.wood.h}px`;
  paint(wood, plate, b.wood.y);
  wood.append(el('div', 'pl-end-bookprops', Books({ books: v.books, preview: null, mode: 'play', layout: b.books.mode, drag: INERT })), sealBox(v, plan, p, fresh, crack), blockersBox(v, plan, p));
  return { stage, wood };
}

function paint(node: HTMLElement, plate: { x: number; y: number; w: number; h: number }, top: number): void {
  node.style.backgroundImage = `url("${ART.plate}")`;
  node.style.backgroundSize = `${plate.w}px ${plate.h}px`;
  node.style.backgroundPosition = `${plate.x}px ${plate.y - top}px`;
}

// ------------------------------------------------------------------ the diffs

function diffsBody(v: ApplyView, plan: ApplyPlan): DocumentFragment {
  const f = document.createDocumentFragment();
  if (v.notes.length) f.append(el('ul', 'pl-end-notes', ...v.notes.map((n) => el('li', '', rich(n)))));
  if (!v.diffs.length) {
    f.append(el('p', 'pl-end-empty', plan.busyText ?? (plan.grants.length ? 'Choose the folders that hold your two files to see the diff.' : 'No diff yet.')));
    return f;
  }
  // Skill bodies first, then the global files: the order the write takes.
  const ordered = [...v.diffs.filter((d) => d.kind === 'skill'), ...v.diffs.filter((d) => d.kind !== 'skill')];
  f.append(el('div', 'pl-end-diffs', ...ordered.map(diffSheet)));
  return f;
}

function diffSheet(d: ApplyDiffView): HTMLElement {
  const lines = el('div', 'pl-end-lines-diff');
  for (const row of diffRows(d.ops)) lines.append(rowEl(d, row));
  return el(
    'article',
    `pl-end-diff pl-end-diff-${d.kind}`,
    el('header', 'pl-end-diffhead', el('b', 'pl-end-difflabel', d.label), el('span', 'pl-end-badge', d.kind === 'skill' ? 'Skill body' : 'Global file'), el('span', 'pl-end-path', d.path)),
    d.weight ? el('p', 'pl-end-weight', `${fmt(d.weight.before)} → ${fmt(d.weight.after)} of ${fmt(d.weight.allowance)} · ${COPY.estimated}`) : null,
    d.problem ? el('p', 'pl-end-warn', rich(d.problem)) : null,
    d.blocker ? el('p', 'pl-end-warn', rich(d.blocker)) : null,
    lines,
  );
}

function lineEl(op: 'same' | 'add' | 'del', line: string): HTMLElement {
  // File bytes are shown exactly: no code-span parsing inside a diff.
  return el('div', `pl-end-ln pl-end-ln-${op}`, el('span', 'pl-end-gut', op === 'add' ? '+' : op === 'del' ? '−' : ' '), el('span', 'pl-end-code', line));
}

function rowEl(d: ApplyDiffView, row: DiffRow): HTMLElement {
  if (row.kind === 'line') return lineEl(row.op, row.line);
  const key = `${d.path}:${row.from}:${row.to}`;
  const unfold = () => d.ops.slice(row.from, row.to).map((o) => lineEl(o.op, o.line));
  if (seen.open.has(key)) {
    const g = el('div', 'pl-end-unfolded');
    g.append(...unfold());
    return g;
  }
  const fold = button('⋯ unchanged lines · show', 'pl-end-fold', () => {
    seen.open.add(key);
    fold.replaceWith(...unfold());
  });
  return fold;
}

// ------------------------------------------------------------------ the end screen

function runBody(v: ApplyView): HTMLElement {
  const s = summaryPlan(v.summary);
  const section = (title: string, ...kids: (Node | null)[]) => el('section', 'pl-end-runsec', el('h3', 'pl-end-runhead', title), ...kids);
  return el(
    'div',
    'pl-end-run',
    section('The score', el('ol', 'pl-end-lines', ...s.lines.map((l) => el('li', '', l)))),
    section(
      'Your files',
      el('ul', 'pl-end-files', ...s.files.map((f) => el('li', '', el('b', '', f.file), ' ', el('span', 'pl-end-fig', f.text), f.raised ? el('span', 'pl-end-raised', ` · ${f.raised}`) : null))),
    ),
    section('Operations', el('p', '', s.operations.length ? s.operations.join(' · ') : 'No committed operations.')),
    section(`Open pages · ${fmt(s.openCount)}`, s.open.length ? el('div', 'pl-end-pages', ...s.open.map((o) => receipt(o.receipt, { compact: true }))) : el('p', 'pl-end-soft', 'No open pages.')),
    section(
      'Set aside, by date',
      s.setAside.length ? el('ul', 'pl-end-asidelist', ...s.setAside.map((x) => el('li', '', el('b', '', x.label), receipt(x.receipt, { compact: true })))) : el('p', 'pl-end-soft', 'Nothing was set aside.'),
    ),
    section('Not written (the shelf)', s.notWritten.length ? el('ul', 'pl-end-shelf', ...s.notWritten.map((c) => el('li', '', el('b', '', c.face.title), ' · ', el('span', 'pl-end-soft', rich(c.face.summary)), el('span', 'pl-end-nw', 'not written')))) : el('p', 'pl-end-soft', 'Nothing on the shelf.')),
    v.footer ? el('p', 'pl-end-footer', v.footer) : null,
  );
}

// ------------------------------------------------------------------ the seal, its three stamps, Undo

function sealBox(v: ApplyView, plan: ApplyPlan, p: ScreenProps<ApplyView>, fresh: string[], crack: boolean): HTMLElement {
  const stamps = el('div', `pl-end-inkrow${v.undo?.status === 'done' ? ' pl-end-undone' : ''}`);
  for (const s of plan.stamps) {
    const order = fresh.indexOf(s.key);
    const slot = el('div', `pl-end-inkslot pl-end-ink-${s.state}${order >= 0 ? ' pl-end-inking' : ''}`, el('span', 'pl-end-inkmark', s.label), el('small', '', s.state === 'failed' ? `did not verify · ${s.meaning}` : s.state === 'undone' ? `undone · the original bytes are back` : s.meaning));
    if (order >= 0) slot.style.setProperty('--i', String(order));
    slot.setAttribute('aria-label', `${s.label}: ${s.state}`);
    stamps.append(slot);
  }
  const verified = v.footer !== null;
  const undone = v.undo?.status === 'done';
  const wax = button(verified ? 'Sealed' : undone ? 'Cracked' : 'Seal', `pl-end-wax${verified ? ' pl-end-pressed' : ''}${undone ? ' pl-end-cracked' : ''}${crack ? ' pl-end-crack' : ''}`, () => void p.api.apply.seal(), !plan.seal);
  wax.title = plan.seal ? 'Write Skill bodies first, then both files, with backups and read-back' : verified ? 'Written and read back' : 'The seal waits until nothing blocks it';
  return el('div', 'pl-end-sealbox', el('div', 'pl-end-sealrow', wax, stamps));
}

/** The write's outcome: the result, which files verified, the backup, Undo and its outcome, the footer. */
function outcome(v: ApplyView, plan: ApplyPlan, p: ScreenProps<ApplyView>): Node[] {
  const r = v.result;
  const parts: (HTMLElement | null)[] = [
    r ? el('p', `pl-end-result pl-end-result-${r.status}`, rich(r.text)) : null,
    plan.files.length ? el('ul', 'pl-end-filestat', ...plan.files.map((f) => el('li', '', el('span', 'pl-end-path', f.path), ` · ${f.text}`))) : null,
    r?.bundle ? el('p', 'pl-end-soft pl-end-backup', 'Backup ', el('span', 'pl-end-path', r.bundle)) : null,
    v.canUndo ? button('Undo · crack the seal', 'pl-end-btn', () => void p.api.apply.undo(), !plan.undo) : null,
    v.undo
      ? v.undo.status === 'refused'
        ? el('p', 'pl-end-warn', rich(v.undo.text ?? 'Undo was refused.'))
        : el('div', 'pl-end-undo', el('span', 'pl-end-label', 'Undo'), el('ul', 'pl-end-filestat', ...v.undo.files.map((f) => el('li', f.conflict ? 'pl-end-warn' : '', el('span', 'pl-end-path', f.path), ` · ${f.text}`))))
      : null,
    v.footer ? el('p', 'pl-end-footer', v.footer) : null,
    v.remember.offered ? rememberBox(v, p) : null,
  ];
  return parts.filter((x): x is HTMLElement => x !== null);
}

/**
 * The second visit (spec §7): keep the receipt and the line ids in this browser, only on the player's word. Off until
 * chosen; one click either way.
 */
function rememberBox(v: ApplyView, p: ScreenProps<ApplyView>): HTMLElement {
  const saved = v.remember.saved;
  return el(
    'div',
    'pl-end-remember',
    el('p', 'pl-end-soft', saved ? 'Kept in this browser: the receipt and the ids of the lines written. No session text is kept.' : 'Keep this receipt in this browser for your next visit? Only the receipt (backup id, files, checksums) and the ids of the lines written; no session text.'),
    button(saved ? 'Forget it' : 'Keep the receipt', 'pl-end-btn', () => p.api.apply.remember(!saved)),
  );
}

/** A browser without folder access: each file's block to paste, with a download; nothing is written (P3). */
function exportedBox(v: ApplyView): HTMLElement | null {
  if (!v.exported) return null;
  const files = v.exported.map((f) => {
    const dl = button(`Download ${f.file}'s block`, 'pl-end-btn', () => {
      const url = URL.createObjectURL(new Blob([f.text], { type: 'text/markdown' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = f.download;
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    dl.dataset.download = f.download;
    return el('section', 'pl-end-export', el('p', '', el('b', '', f.file), ' · ', el('span', 'pl-end-path', f.path)), f.text ? el('pre', 'pl-end-exportblock', f.text) : el('p', 'pl-end-soft', 'No change.'), f.text ? dl : null);
  });
  return el(
    'div',
    'pl-end-exported',
    el('h3', 'pl-end-runhead', 'Exported, not applied'),
    el('p', 'pl-end-soft', 'This browser cannot write files, so nothing was changed on disk. Paste each block at the end of the file named above it, or download it.'),
    ...files,
  );
}

// ------------------------------------------------------------------ blockers and grants

function blockersBox(v: ApplyView, plan: ApplyPlan, p: ScreenProps<ApplyView>): HTMLElement {
  const box = el('div', 'pl-end-blockers');
  const ex = exportedBox(v);
  if (ex) box.append(ex);
  box.append(...outcome(v, plan, p));
  if (plan.busyText) box.append(el('p', 'pl-end-busy', plan.busyText));
  const required = plan.grants.filter((g) => !g.optional);
  const grantButtons = () => required.map((g) => button(g.label, 'pl-end-btn pl-end-primary', () => void p.api.apply.grant(g.which), plan.locked));
  const hasGrantBlocker = plan.blockers.some((b) => b.kind === 'grant');
  for (const b of plan.blockers) {
    const acts = el('div', 'pl-end-actions');
    for (const a of b.actions) {
      if (a === 'grant') acts.append(...grantButtons());
      if (a === 'reread') acts.append(button('Read the files again', 'pl-end-btn', () => void p.api.apply.prepare(), plan.locked));
      if (a === 'return') acts.append(button('Return to the final campfire', 'pl-end-btn', () => p.api.apply.returnToCampfire(b.select), plan.locked));
    }
    box.append(el('div', `pl-end-blocker pl-end-blocker-${b.kind}`, el('p', '', rich(b.text)), acts));
  }
  // Optional grants (the ~/.agents folder for Codex Skills) and any grant not already offered by a blocker.
  const loose = plan.grants.filter((g) => !hasGrantBlocker || g.optional);
  if (loose.length) box.append(el('div', 'pl-end-actions', ...loose.map((g) => button(g.label, 'pl-end-btn', () => void p.api.apply.grant(g.which), plan.locked))));
  if (!plan.blockers.length && plan.seal) box.append(el('p', 'pl-end-soft', 'Nothing blocks the seal. Open pages never do.'));
  return box;
}
