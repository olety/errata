// Parse-time redaction. Every text field, tool input and tool result passes through redact()
// before it is stored, rendered or logged. Secrets become "[redacted:<kind>]" and are counted per session.

import type { RedactionCounts } from './model';
import { CUT_MARKER } from './model';

export type RedactKind =
  | 'private-key'
  | 'jwt'
  | 'anthropic-key'
  | 'openai-key'
  | 'github-token'
  | 'aws-key'
  | 'slack-token'
  | 'google-key'
  | 'auth-header'
  | 'bearer'
  | 'url-credentials'
  | 'assignment'
  | 'keyish-blob';

interface Rule {
  kind: RedactKind;
  re: RegExp;
  /** Index of the capture group to replace; 0 = whole match. Groups before it are kept verbatim. */
  group?: number;
}

// Key-ish words: a long opaque run is only redacted when one of these sits right before it.
const KEYISH = String.raw`(?:api[_-]?key|apikey|secret[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|secret|token|passw(?:or)?d|passwd|pwd|auth|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?key|signature|bearer|x-api-key)`;

// Exact field names, optionally prefixed by separator-delimited names such as OPENAI_API_KEY.
const ASSIGN_NAME = String.raw`(?<![\w.-])(?:[A-Za-z0-9]+[_.-])*${KEYISH}(?![\w.-])`;
const ASSIGN_PREFIX = String.raw`${ASSIGN_NAME}(?:\\?["'])?\s*[:=]\s*`;

// Order matters: specific shapes first, so a JWT inside an Authorization header is reported as auth-header
// only once the header rule runs on what remains.
const RULES: Rule[] = [
  // PEM private keys; an unterminated block (cut by a window) is redacted to the end of the string.
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: 'auth-header', re: /(\bAuthorization\s*[:=]\s*["']?)((?:Basic|Bearer|Token|Digest|Bot)\s+[^\s"',;]+|[^\s"',;]{8,})/gi, group: 2 },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'bearer', re: /(\bBearer[ \t]+)([A-Za-z0-9._~+/=-]+)/gi, group: 2 },
  { kind: 'url-credentials', re: /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:/?#@]+:[^\s/?#@]*|[A-Za-z0-9._~%+-]{20,})(@)/gi, group: 2 },
  // Escaped JSON string values, then ordinary double/single-quoted values.
  {
    kind: 'assignment',
    re: new RegExp(String.raw`(${ASSIGN_PREFIX}\\")((?:(?!\\")[\s\S])+)(\\")`, 'gi'),
    group: 2,
  },
  {
    kind: 'assignment',
    re: new RegExp(String.raw`(${ASSIGN_PREFIX}")((?:\\.|[^"\\])+)(")`, 'gi'),
    group: 2,
  },
  {
    kind: 'assignment',
    re: new RegExp(String.raw`(${ASSIGN_PREFIX}')((?:\\.|[^'\\])+)(')`, 'gi'),
    group: 2,
  },
  // A bare .env/shell value is a non-whitespace run, including ; and #.
  {
    kind: 'assignment',
    re: new RegExp(String.raw`(^[ \t]*(?:export[ \t]+)?${ASSIGN_NAME}[ \t]*=[ \t]*)([^\s"']+)`, 'gim'),
    group: 2,
  },
  // Other bare values: stop at a query delimiter or a structured-text delimiter.
  {
    kind: 'assignment',
    re: new RegExp(String.raw`(${ASSIGN_PREFIX})([^\s"',;&?#)}\]\\]+)`, 'gi'),
    group: 2,
  },
  // 32+ hex or base64 run with a key-ish word within a few characters before it.
  {
    kind: 'keyish-blob',
    re: new RegExp(String.raw`((?<![\w.-])${KEYISH}(?![A-Za-z0-9_])(?:[ \t]+\([^\n)]{1,64}\))?[ \t]*(?:(?:[:=/]|->|-)[ \t]*)?)([A-Za-z0-9+/_-]{32,}={0,2})`, 'gi'),
    group: 2,
  },
];

const PLACEHOLDER = /^\[redacted:[a-z-]+\]$/;

export function redact(input: string, counts?: RedactionCounts): string {
  if (!input) return input;
  let s = input;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    s = s.replace(rule.re, (...m: unknown[]) => {
      const groups = m.slice(0, -2).filter((x) => typeof x === 'string' || x === undefined) as (string | undefined)[];
      const whole = groups[0] ?? '';
      const g = rule.group ?? 0;
      const target = g === 0 ? whole : groups[g] ?? '';
      if (!target || PLACEHOLDER.test(target) || target.startsWith('[redacted:')) return whole;
      if (counts) counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      const tag = `[redacted:${rule.kind}]`;
      if (g === 0) return tag;
      // Rebuild: keep groups before g, replace g, keep groups after g.
      let out = '';
      for (let i = 1; i < groups.length; i++) out += i === g ? tag : groups[i] ?? '';
      return out;
    });
  }
  return s;
}

/** Truncate to a head window, then redact. A secret cut at the window edge is still caught or harmless. */
export function redactBounded(input: string | null | undefined, limit: number, counts?: RedactionCounts): string {
  if (!input) return '';
  const head = input.length > limit ? input.slice(0, limit) + CUT_MARKER : input;
  return redact(head, counts);
}
