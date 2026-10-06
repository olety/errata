// Global instruction files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md): the managed block, protected text
// byte-for-byte, whole-file weight (spec §5, §9). Works on bytes so text outside the block can never shift.

export const BEGIN = '<!-- deck:begin v1 -->';
export const END = '<!-- deck:end -->';
export const ALLOWANCE = 1200;
/** Conservative hard cap for any instruction file we write (Codex project_doc_max_bytes default, 32 KiB). */
export const MAX_FILE_BYTES = 32 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

export interface ManagedLine {
  id: string;
  text: string;
  section: 'rules' | 'workflows';
}

export interface ParsedGlobal {
  bytes: Uint8Array;
  eol: '\n' | '\r\n';
  /** Byte range of the managed block, end-exclusive, including the end marker's line break. Null = no block. */
  block: { start: number; end: number } | null;
  managed: ManagedLine[];
  /** Why this file cannot be written by the game (malformed markers). Null = writable. */
  problem: string | null;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function lineStart(b: Uint8Array, i: number): number {
  while (i > 0 && b[i - 1] !== 10) i--;
  return i;
}

function lineEndInclusive(b: Uint8Array, i: number): number {
  while (i < b.length && b[i] !== 10) i++;
  return i < b.length ? i + 1 : i;
}

const BEGIN_B = enc.encode('<!-- deck:begin');
const END_B = enc.encode(END);
const ITEM = /^- (.*?) <!-- deck:([a-z]_[a-z0-9]+) -->\r?$/;

export function parseGlobal(bytes: Uint8Array | null): ParsedGlobal {
  const b = bytes ?? new Uint8Array(0);
  const eol: '\n' | '\r\n' = indexOfBytes(b, enc.encode('\r\n')) >= 0 ? '\r\n' : '\n';
  const out: ParsedGlobal = { bytes: b, eol, block: null, managed: [], problem: null };
  const s0 = indexOfBytes(b, BEGIN_B);
  const e0 = indexOfBytes(b, END_B);
  if (s0 < 0 && e0 < 0) return out;
  if (s0 < 0 || e0 < 0 || e0 < s0) {
    out.problem = 'The file has a deck marker without its partner. Fix or remove the markers by hand first.';
    return out;
  }
  if (indexOfBytes(b, BEGIN_B, s0 + 1) >= 0 || indexOfBytes(b, END_B, e0 + 1) >= 0) {
    out.problem = 'The file has more than one managed block. Keep one and remove the other by hand first.';
    return out;
  }
  const start = lineStart(b, s0);
  const end = lineEndInclusive(b, e0);
  out.block = { start, end };
  const inner = dec.decode(b.subarray(start, end)).split('\n');
  let section: ManagedLine['section'] = 'rules';
  for (const raw of inner) {
    const line = raw.replace(/\r$/, '');
    if (/^##\s+Reusable workflows/.test(line)) section = 'workflows';
    else if (/^##\s+Reviewed working rules/.test(line)) section = 'rules';
    const m = ITEM.exec(line);
    if (m) out.managed.push({ id: m[2]!, text: m[1]!, section });
  }
  return out;
}

/** One exported line: no line breaks, no comment terminators, trimmed. */
export function sanitizeLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/-->/g, '→').replace(/<!--/g, '').replace(/\s+/g, ' ').trim();
}

export function renderBlock(lines: ManagedLine[], eol: string): string {
  const rules = lines.filter((l) => l.section === 'rules');
  const flows = lines.filter((l) => l.section === 'workflows');
  const out: string[] = [BEGIN];
  if (rules.length) {
    out.push('## Reviewed working rules');
    for (const l of rules) out.push(`- ${sanitizeLine(l.text)} <!-- deck:${l.id} -->`);
  }
  if (flows.length) {
    out.push('## Reusable workflows');
    for (const l of flows) out.push(`- ${sanitizeLine(l.text)} <!-- deck:${l.id} -->`);
  }
  out.push(END);
  return out.join(eol) + eol;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * A player-approved change to one line of protected text (outside the managed block): cut it, or replace its text.
 * start/end are the line's byte range including its line break; prefix is the line's own bullet or indent.
 */
export interface ProtectedEdit {
  start: number;
  end: number;
  /** null = cut the whole line. */
  text: string | null;
  prefix: string;
  eol: string;
}

/** Apply protected-line edits. Every byte outside the edited lines is copied as it was. */
export function applyProtectedEdits(b: Uint8Array, edits: readonly ProtectedEdit[]): Uint8Array {
  if (edits.length === 0) return b;
  const sorted = [...edits].sort((x, y) => x.start - y.start);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const e of sorted) {
    if (e.start < at || e.end > b.length || e.end < e.start) throw new Error('Overlapping or out-of-range line edits.');
    parts.push(b.subarray(at, e.start));
    if (e.text !== null) parts.push(enc.encode(`${e.prefix}${sanitizeLine(e.text)}${e.eol}`));
    at = e.end;
  }
  parts.push(b.subarray(at));
  return concat(...parts);
}

/**
 * Next bytes for a global file. Text outside the managed block is copied byte-for-byte, except protected lines the
 * player explicitly cut or replaced (edits). No lines, no edits and no existing block → the original bytes unchanged.
 */
export function renderGlobal(p0: ParsedGlobal, lines: ManagedLine[], edits: readonly ProtectedEdit[] = []): Uint8Array {
  if (p0.problem) throw new Error(p0.problem);
  if (p0.block && edits.some((e) => e.end > p0.block!.start && e.start < p0.block!.end)) throw new Error('A line edit reaches into the managed block.');
  const p = edits.length ? parseGlobal(applyProtectedEdits(p0.bytes, edits)) : p0;
  const b = p.bytes;
  if (p.block) {
    const prefix = b.subarray(0, p.block.start);
    const suffix = b.subarray(p.block.end);
    if (lines.length === 0) {
      // Remove the block and the single blank separator line we add on first insert, if present.
      let pre = prefix;
      const eolB = enc.encode(p.eol);
      const sep = concat(eolB, eolB);
      if (suffix.length === 0 && pre.length >= sep.length && endsWith(pre, sep)) pre = pre.subarray(0, pre.length - eolB.length);
      return concat(pre, suffix);
    }
    return concat(prefix, enc.encode(renderBlock(lines, p.eol)), suffix);
  }
  if (lines.length === 0) return b;
  const eolB = enc.encode(p.eol);
  let sep: Uint8Array;
  if (b.length === 0) sep = new Uint8Array(0);
  else if (endsWith(b, concat(eolB, eolB))) sep = new Uint8Array(0);
  else if (endsWith(b, eolB)) sep = eolB;
  else sep = concat(eolB, eolB);
  return concat(b, sep, enc.encode(renderBlock(lines, p.eol)));
}

function endsWith(b: Uint8Array, tail: Uint8Array): boolean {
  if (tail.length > b.length) return false;
  for (let i = 0; i < tail.length; i++) if (b[b.length - tail.length + i] !== tail[i]) return false;
  return true;
}

export interface Weight {
  /** Estimated tokens: rendered UTF-8 bytes ÷ 3, rounded up, summed by block. */
  total: number;
  protectedBefore: number;
  managed: number;
  protectedAfter: number;
  bytes: number;
}

const est = (n: number) => Math.ceil(n / 3);

export function weigh(bytes: Uint8Array): Weight {
  const p = parseGlobal(bytes);
  if (!p.block) {
    return { total: est(bytes.length), protectedBefore: est(bytes.length), managed: 0, protectedAfter: 0, bytes: bytes.length };
  }
  const a = est(p.block.start);
  const m = est(p.block.end - p.block.start);
  const z = est(bytes.length - p.block.end);
  return { total: a + m + z, protectedBefore: a, managed: m, protectedAfter: z, bytes: bytes.length };
}

/** Weight of one card line as it would render. */
export function lineWeight(text: string, id: string): number {
  return est(enc.encode(`- ${sanitizeLine(text)} <!-- deck:${id} -->\n`).length);
}

export interface Budget {
  allowance: number;
  /** The imported file was already over the allowance: it may not grow. */
  noGrowth: boolean;
}

export function budgetFor(original: Uint8Array | null): Budget {
  const w = weigh(original ?? new Uint8Array(0)).total;
  return w > ALLOWANCE ? { allowance: w, noGrowth: true } : { allowance: ALLOWANCE, noGrowth: false };
}

/** Why Apply is blocked for this file, or null. */
export function fitProblem(original: Uint8Array | null, next: Uint8Array, raisedAllowance?: number): string | null {
  const b = budgetFor(original);
  const allowance = Math.max(b.allowance, raisedAllowance ?? 0);
  const w = weigh(next).total;
  if (next.length > MAX_FILE_BYTES) return `The file would be ${next.length} bytes; the limit is ${MAX_FILE_BYTES}.`;
  if (w > allowance) return `The file would use ${w} tokens (estimated), over its token budget of ${allowance}.`;
  return null;
}

export const text = (b: Uint8Array) => dec.decode(b);
export const bytes = (s: string) => enc.encode(s);
