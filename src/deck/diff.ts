// Line diff for the Apply preview. Files are small (a few hundred lines), so a plain LCS table is enough.

export type DiffOp = { op: 'same' | 'add' | 'del'; line: string };

export function lineDiff(a: string, b: string): DiffOp[] {
  const A = a === '' ? [] : a.split('\n');
  const B = b === '' ? [] : b.split('\n');
  const n = A.length;
  const m = B.length;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = A[i] === B[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ op: 'same', line: A[i]! });
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ op: 'del', line: A[i++]! });
    else out.push({ op: 'add', line: B[j++]! });
  }
  while (i < n) out.push({ op: 'del', line: A[i++]! });
  while (j < m) out.push({ op: 'add', line: B[j++]! });
  return out;
}

/** Unified-style text with up to `context` unchanged lines around each change. */
export function renderDiff(ops: DiffOp[], context = 2): string {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, i) => {
    if (!keep[i]) {
      if (!skipped) out.push('  …');
      skipped = true;
      return;
    }
    skipped = false;
    out.push((o.op === 'add' ? '+ ' : o.op === 'del' ? '- ' : '  ') + o.line);
  });
  return out.join('\n');
}
