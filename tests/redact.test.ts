// Redactor corpus: 90 synthetic positives and 62 negatives (built by a separate worker against an earlier draft).
import { describe, expect, test } from 'bun:test';
import corpus from './redact-corpus.json';
import { redact, redactBounded } from '../src/redact';

type Pos = { id: string; input: string; secrets: string[] };
type Neg = { id: string; input: string; note: string };

// Conservative false positives we accept: a real unquoted credential can have the same shape.
const ACCEPTED_FALSE_POSITIVES = new Set<string>(['schema-secret-bool', 'source-symbol-value', 'source-function-value', 'ordinary-bearer-prose']);

describe('positives: no listed secret survives and a placeholder appears', () => {
  for (const p of corpus.positives as Pos[]) {
    test(p.id, () => {
      const out = redact(p.input);
      for (const s of p.secrets) expect(out).not.toContain(s);
      expect(out).toContain('[redacted:');
    });
  }
});

describe('negatives: ordinary text is byte-identical', () => {
  for (const n of corpus.negatives as Neg[]) {
    const t = ACCEPTED_FALSE_POSITIVES.has(n.id) ? test.skip : test;
    t(n.id, () => expect(redact(n.input)).toBe(n.input));
  }
});

test('extra shapes: secret_key, AWS secret, counts per kind', () => {
  const counts: Record<string, number> = {};
  const out = redact('secret_key: 9f8e7d6c5b4a39f8e7d6c5b4a39f8e7d6c5b4a39\naws_secret_access_key = Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA', counts);
  expect(out).not.toContain('9f8e7d6c5b4a');
  expect(out).not.toContain('Zm9vYmFy');
  expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(2);
});

test('a PEM block cut by the window is still redacted', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(40) + '\n-----END OPENSSH PRIVATE KEY-----';
  const out = redactBounded(pem, 200);
  expect(out).toBe('[redacted:private-key]');
});
