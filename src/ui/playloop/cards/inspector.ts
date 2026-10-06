// Owner: cards/layout. The one inspector (play-loop §0a.15, §10 back + drawer merged): full text, receipts, mapping
// approval and editing; and the draft comparison (two playPreviews on the same proposal, side by side).
// Import from ../contract only. Never the adapter or the engine.
import type { Agent, CardView, ChangePreviewView, ControllerApi, DragPreview, InspectorView, MappingReviewView, ReadingView, ReceiptView, Targets } from '../contract';
import { AGENT_NAME, COPY, FILE_OF } from '../contract';
import { button, el, fig, inline, Sigil } from './dom';
import './cards.css';

export interface InspectorProps {
  card: CardView | null;
  receipt: ReceiptView | null;
  /** On phones the inspector replaces the stage or opens as a sheet (§0a.15). */
  layout: 'side' | 'sheet' | 'stage';
  api: ControllerApi;
  /**
   * Optional (not in the frozen props; see the contract asks): the resolved `ui.inspector`. When given it wins: the
   * reading, every session's receipt, the per-case mapping rows, or a case's receipt with its room's queue.
   */
  view?: InspectorView | null;
}

const LANES: Agent[] = ['claude', 'codex'];
const TARGETS: { t: Targets; label: string }[] = [
  { t: 'claude', label: 'Claude' },
  { t: 'both', label: 'Both' },
  { t: 'codex', label: 'Codex' },
];

/** The one inspector: full text, receipts, mapping approval and editing (§0a.15). */
export function Inspector(p: InspectorProps): HTMLElement {
  const v = p.view ?? null;
  const card = v?.kind === 'card' ? v.card : p.card;
  const close = button('pl-cards-close', '×', () => p.api.inspect(null), 'Close the inspector');
  const root = el('aside', `pl-cards-inspector pl-cards-insp-${p.layout}`);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', card ? `Inspector: ${card.face.title}` : 'Inspector: receipt');
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  let body: HTMLElement;
  if (v?.kind === 'case') body = CaseBody(v.receipt, v.queue, p.api);
  else if (card) body = CardBody(card, v?.kind === 'card' ? v : null, p.api);
  else if (p.receipt) body = CaseBody(p.receipt, [], p.api);
  else body = el('p', 'pl-cards-insp-empty', 'Nothing to inspect here.');
  root.append(el('div', 'pl-cards-insp-bar', el('span', 'pl-cards-insp-kicker', card ? typeName(card.type) : 'Receipt'), close), body);
  return root;
}

function typeName(t: CardView['type']): string {
  return { rule: 'Rule', skill: 'Skill', protected: 'Protected text', trait: 'Trait' }[t];
}

// ------------------------------------------------------------------ a card

function CardBody(c: CardView, v: Extract<InspectorView, { kind: 'card' }> | null, api: ControllerApi): HTMLElement {
  const i = c.inspector;
  const reading: ReadingView = v?.reading ?? { text: i.exact, scope: i.scope, exceptions: i.exceptions, files: c.inFiles.map((a) => FILE_OF[a]) };
  const body = el('div', 'pl-cards-insp-body');
  body.append(el('h2', 'pl-cards-insp-title', c.face.title));

  // The reading: the exact line in mono, scope, exceptions and destination files at reading size (§0a.5).
  body.append(
    Section(
      'The line as it lands',
      el('p', 'pl-cards-exact', i.exact),
      Chips([
        ['Targets', chip(c.targets === 'both' ? 'Claude and Codex' : AGENT_NAME[c.targets])],
        ['Scope', chip(reading.scope)],
        ['Trigger', i.trigger ? chip(i.trigger) : chip('none', true)],
        ['Exceptions', ...(reading.exceptions[0] !== undefined ? reading.exceptions.map((x) => chip(x)) : [chip('none', true)])],
        ['Files', ...(reading.files[0] !== undefined ? reading.files.map((f) => chip(f, false, true)) : [chip('not in a file yet', true)])],
      ]),
      el('p', 'pl-cards-weightmath', el('span', 'pl-cards-mono', i.weightMath), ` ${COPY.estimated}`),
    ),
  );

  if (c.footer) body.append(el('p', 'pl-cards-insp-room', el('b', '', c.footer.text), ` · ${COPY.ifAccepted}`));
  if (c.type === 'protected') body.append(el('p', 'pl-cards-insp-note', 'Kept byte-for-byte.'));

  // A Skill: the first lines of its SKILL.md body and its own estimate, outside the allowance.
  if (i.skill) {
    body.append(
      Section(
        'SKILL.md',
        el('pre', 'pl-cards-skill', i.skill.firstLines.join('\n')),
        el('p', 'pl-cards-insp-note', el('span', 'pl-cards-mono', `+${fig(i.skill.estimate)}`), ` ${COPY.estimated} · outside the allowance`),
      ),
    );
  }

  // Mapping approval: one row per case, Accept when eligible and not yet accepted (check 8).
  if (i.needsAcceptance) body.append(el('div', 'pl-cards-insp-act', button('pl-cards-btn pl-cards-btn-ink', 'Accept this reading', () => api.campfire.acceptImport(c.id)), el('span', 'pl-cards-insp-note', 'This text changed or came from your file: its cases count only once you accept it.')));
  if (v && v.mappings[0] !== undefined) body.append(Section('Cases this line can answer', ...v.mappings.map((m) => MappingRow(m, api))));

  // Evidence: each session with its receipt.
  const ev = v
    ? v.evidence.map((e) => (e.receipt ? Receipt(e.receipt, e.sessionLabel) : el('div', 'pl-cards-receipt', el('p', 'pl-cards-r-session', e.sessionLabel))))
    : [
        ...(i.quote !== null ? [el('blockquote', 'pl-cards-quote', i.quote)] : [el('p', 'pl-cards-r-none', 'Tool evidence only')]),
        ...i.evidence.map((e) => el('p', 'pl-cards-r-meta', Sigil(e.agent, true), ` ${AGENT_NAME[e.agent]} · `, el('span', 'pl-cards-mono', e.date ?? 'no date'), ' · ', el('span', 'pl-cards-r-session', e.sessionLabel))),
      ];
  body.append(Section(`Evidence · ${c.provenance}`, ...ev));

  if (i.unavailable[0] !== undefined) body.append(Section('Not dealt here', el('ul', 'pl-cards-reasons', ...i.unavailable.map((r) => el('li', '', r)))));

  // Edits, for a card already in the proposal: the target chips (narrow or widen) and the line itself (sharpen).
  if (c.inFiles[0] !== undefined && c.type !== 'protected') body.append(Edits(c, api));
  return body;
}

function MappingRow(m: MappingReviewView, api: ControllerApi): HTMLElement {
  const r = m.receipt;
  const state = m.accepted ? el('span', 'pl-cards-map-ok', 'Accepted') : m.eligible ? button('pl-cards-btn pl-cards-btn-ink', 'Accept', () => api.campfire.acceptMapping(m.cardId, m.caseId), `Accept this line for the case of ${r.date ?? 'no date'}`) : el('span', 'pl-cards-map-no', m.reason ?? 'not eligible');
  return el(
    'div',
    `pl-cards-map${m.accepted ? ' is-accepted' : ''}`,
    el('div', 'pl-cards-map-tag', Sigil(r.agent, true), ` ${AGENT_NAME[r.agent]}`, r.project ? ` · ${r.project}` : '', ' · ', el('span', 'pl-cards-mono', r.date ?? 'no date')),
    el('p', 'pl-cards-map-quote', r.quote ?? 'Tool evidence only'),
    el('div', 'pl-cards-map-state', state, m.reason && !m.accepted && m.eligible ? el('span', 'pl-cards-map-no', m.reason) : null),
  );
}

function Edits(c: CardView, api: ControllerApi): HTMLElement {
  const out = el('div', 'pl-cards-preview');
  const stage = (pv: ChangePreviewView | null, confirm: HTMLButtonElement) => {
    confirm.disabled = !pv || !!pv.refused;
    out.replaceChildren(...(pv ? [ChangePreview(pv), confirm] : [el('p', 'pl-cards-insp-note', 'This change cannot be previewed here.')]));
  };
  const chips = el(
    'div',
    'pl-cards-targets',
    ...TARGETS.map(({ t, label }) => {
      const b = button(`pl-cards-chipbtn${c.targets === t ? ' is-on' : ''}`, label, () => {
        if (t === c.targets) return out.replaceChildren();
        const pv = api.campfire.changePreview({ retarget: { cardId: c.id, targets: t } });
        stage(pv, button('pl-cards-btn pl-cards-btn-ink', `Re-target to ${label}`, () => api.campfire.retarget(c.id, t)));
      });
      b.setAttribute('aria-pressed', String(c.targets === t));
      return b;
    }),
  );
  const area = el('textarea', 'pl-cards-edit');
  area.value = c.inspector.exact;
  area.rows = 4;
  area.setAttribute('aria-label', 'Edit the line');
  area.addEventListener('input', () => {
    const text = area.value;
    if (text === c.inspector.exact) return out.replaceChildren();
    const pv = api.campfire.changePreview({ sharpen: { cardId: c.id, text } });
    stage(pv, button('pl-cards-btn pl-cards-btn-ink', 'Save the line', () => api.campfire.sharpen(c.id, area.value)));
  });
  return Section('Change this card', el('div', 'pl-cards-insp-row', el('span', 'pl-cards-label', 'Writes to'), chips), area, el('p', 'pl-cards-insp-note', 'Saving changes the text: its cases count again only once you accept it.'), out);
}

/** A change before its seal: per-lane ghosts with "estimated", the cases line, and what needs accepting again. */
export function ChangePreview(pv: ChangePreviewView): HTMLElement {
  return el(
    'div',
    'pl-cards-change',
    ...LANES.map((a) => el('p', 'pl-cards-ghostline', el('b', '', FILE_OF[a]), ' ', el('span', 'pl-cards-mono', `${fig(pv.ghost[a].before)} → ${fig(pv.ghost[a].after)}`), ` · ${pv.ghost[a].text} ${COPY.estimated}`)),
    el('p', 'pl-cards-ghostline', pv.cases.text),
    pv.needsAcceptance[0] !== undefined ? el('p', 'pl-cards-insp-note', 'The new text must be accepted again for the cases it answers.') : null,
    pv.refused ? el('p', 'pl-cards-refused', pv.refused) : null,
  );
}

// ------------------------------------------------------------------ a case

function CaseBody(r: ReceiptView, queue: ReceiptView[], api: ControllerApi): HTMLElement {
  const body = el('div', 'pl-cards-insp-body', Receipt(r, null));
  if (queue[0] !== undefined) {
    body.append(
      Section(
        "This room's cases",
        el(
          'ol',
          'pl-cards-queue',
          ...queue.map((q) => {
            const here = q.caseId === r.caseId;
            const b = button(`pl-cards-qbtn${here ? ' is-here' : ''}`, el('span', '', Sigil(q.agent, true), ` ${q.project ?? AGENT_NAME[q.agent]} · `, el('span', 'pl-cards-mono', q.date ?? 'no date')), () => api.inspect({ caseId: q.caseId }));
            if (here) b.setAttribute('aria-current', 'true');
            return el('li', '', b);
          }),
        ),
      ),
    );
  }
  return body;
}

/** One complete receipt: the human's words (or "Tool evidence only"), action → result → then, agent, project, date. */
export function Receipt(r: ReceiptView, session: string | null): HTMLElement {
  return el(
    'div',
    'pl-cards-receipt',
    r.quote !== null ? el('blockquote', 'pl-cards-quote', r.quote) : el('p', 'pl-cards-r-none', 'Tool evidence only'),
    r.pasted ? el('p', 'pl-cards-insp-note', 'Pasted text, not typed words.') : null,
    r.action || r.result ? el('p', 'pl-cards-r-action', r.action ?? '', r.result ? ` → ${r.result}` : '', r.then ? ` → ${r.then}` : '') : null,
    el('p', 'pl-cards-r-meta', Sigil(r.agent, true), ` ${AGENT_NAME[r.agent]}`, r.project ? ` · ${r.project}` : '', ' · ', el('span', 'pl-cards-mono', r.date ?? 'no date')),
    session ? el('p', 'pl-cards-r-session', session) : null,
  );
}

// ------------------------------------------------------------------ the draft comparison

export interface CompareRow {
  caseId: string;
  a: { glow: boolean; word: string | null } | null;
  b: { glow: boolean; word: string | null } | null;
}

/** Align two previews' heads by case id (same proposal, same heads), keeping the room's order. */
export function compareRows(a: DragPreview, b: DragPreview): CompareRow[] {
  const order: string[] = [];
  for (const h of [...a.heads, ...b.heads]) if (!order.includes(h.caseId)) order.push(h.caseId);
  const pick = (p: DragPreview, id: string) => {
    const h = p.heads.find((x) => x.caseId === id);
    return h ? { glow: h.glow, word: h.word } : null;
  };
  return order.map((caseId) => ({ caseId, a: pick(a, caseId), b: pick(b, caseId) }));
}

export interface ComparisonProps {
  a: CardView;
  b: CardView;
  layout: 'side' | 'sheet';
  onClose(): void;
  onInspect(cardId: string): void;
}

/** Two drafts' playPreviews side by side: destination files, the heads each would light, per-lane ghosts. */
export function Comparison(p: ComparisonProps): HTMLElement {
  const pa = p.a.playPreview!;
  const pb = p.b.playPreview!;
  const rows = compareRows(pa, pb);
  const col = (c: CardView, pv: DragPreview, side: 'a' | 'b') =>
    el(
      'div',
      'pl-cards-cmp-col',
      button('pl-cards-cmp-title', c.face.title, () => p.onInspect(c.id), `Inspect ${c.face.title}`),
      el('p', 'pl-cards-cmp-files', pv.refused ? el('span', 'pl-cards-refused', pv.refused) : pv.line ? pv.line.files.join(' · ') : 'no files'),
      c.footer ? el('p', 'pl-cards-cmp-room', c.footer.text) : null,
      el(
        'ol',
        'pl-cards-cmp-heads',
        ...rows.map((r, i) => {
          const h = r[side];
          return el('li', h?.glow ? 'is-glow' : '', el('span', 'pl-cards-cmp-pip'), el('span', '', h ? (h.glow ? `Head ${i + 1} · lights` : `Head ${i + 1} · ${h.word ?? 'no'}`) : `Head ${i + 1} · —`));
        }),
      ),
      ...LANES.map((a) => el('p', 'pl-cards-ghostline', el('b', '', FILE_OF[a]), ' ', `${pv.ghost[a].text} ${COPY.estimated}`)),
    );
  const root = el(
    'section',
    `pl-cards-compare pl-cards-insp-${p.layout}`,
    el('div', 'pl-cards-insp-bar', el('span', 'pl-cards-insp-kicker', 'Two drafts on the same files'), button('pl-cards-close', '×', p.onClose, 'Close the comparison')),
    el('div', 'pl-cards-cmp', col(p.a, pa, 'a'), col(p.b, pb, 'b')),
  );
  root.setAttribute('aria-label', `Compare ${p.a.face.title} and ${p.b.face.title}`);
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  return root;
}

// ------------------------------------------------------------------ small parts

function Section(title: string, ...kids: (Node | null)[]): HTMLElement {
  return el('section', 'pl-cards-insp-sec', el('h3', 'pl-cards-insp-h', title), ...kids);
}

function chip(text: string, quiet = false, file = false): HTMLElement {
  return el('span', `pl-cards-chip${quiet ? ' is-quiet' : ''}${file ? ' is-file' : ''}`, ...inline(text));
}

function Chips(rows: [string, ...HTMLElement[]][]): HTMLElement {
  return el('dl', 'pl-cards-chips', ...rows.flatMap(([k, ...v]) => [el('dt', '', k), el('dd', '', ...v)]));
}
