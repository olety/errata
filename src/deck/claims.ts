// Structured claims (see Claim in ./types.ts). Templates carry claims by construction. Imported prose gets a SUGGESTED
// set from the small fixed vocabulary below; the player accepts or edits it. Claims decide two things only: whether
// two cards conflict (opposed actions under overlapping conditions) and whether two cards say the same thing.
// They never decide coverage.

import type { Claim } from './types';

const TOOLS = ['uv', 'pip', 'pip3', 'pipx', 'poetry', 'conda', 'npm', 'npx', 'bun', 'bunx', 'pnpm', 'yarn', 'deno', 'cargo', 'brew', 'docker', 'make', 'tsc', 'eslint', 'prettier', 'biome', 'ruff', 'black'];
const NEG_BEFORE = /\b(?:not|never|no|avoid|don'?t|dont|do not|instead of|over|rather than|without)\s*$/;
const FULL_TESTS = /\b(?:full|whole|entire|complete)\s+(?:test\s+)?suite\b|\ball\s+(?:the\s+)?tests\b|\brun\s+everything\b/;
const FOCUSED_TESTS = /\b(?:focused|single|one|only\s+the)\s+test(?:\s+file)?\b|\bthe\s+test\s+file\b/;
const FORCE_PUSH = /\bforce[- ]?push(?:es|ing)?\b|\bpush\s+(?:--force|-f)\b/;
const REPORT = /\breport\b[^.;]*\b(?:changed|change|changes|result|results|did)\b|\bsummar(?:y|ise|ize)\b[^.;]*\b(?:change|result)/;

function whenOf(t: string): string | undefined {
  if (/\bbefore\s+(?:reporting|saying|claiming|declaring|calling)\b[^.;]*\bdone\b|\bbefore\s+(?:you\s+)?(?:finish|report)/.test(t)) return 'before-done';
  if (/\b(?:after|when)\s+(?:an?\s+)?interrupt/.test(t)) return 'after-interrupt';
  return undefined;
}

function unlessOf(t: string): string | undefined {
  const m = /\b(?:except|unless|other than)\b[^.;]*/.exec(t);
  return m ? m[0].trim().replace(/[,\s]+$/, '') : undefined;
}

/** Negation words in the same clause, before position i. */
function negatedAt(t: string, i: number): boolean {
  const start = Math.max(t.lastIndexOf(',', i - 1), t.lastIndexOf('.', i - 1), t.lastIndexOf(';', i - 1)) + 1;
  const clause = t.slice(start, i);
  if (NEG_BEFORE.test(clause)) return true;
  return /\b(?:never|don'?t|dont|do not|avoid|no)\b/.test(clause) && !/\bonly\b/.test(clause);
}

/** Suggested claims for a line of prose. Empty when nothing in the vocabulary matches. */
export function suggestClaims(text: string): Claim[] {
  const t = text.toLowerCase().replace(/[`*_]/g, '');
  const out: Claim[] = [];
  const when = whenOf(t);
  const unless = unlessOf(t);
  const push = (c: Claim) => {
    if (!out.some((x) => claimKey(x) === claimKey(c))) out.push(c);
  };
  const extra = (c: Claim): Claim => ({ ...c, ...(when ? { when } : {}), ...(unless ? { unless } : {}) });
  let m = FULL_TESTS.exec(t);
  if (m) push(extra({ polarity: negatedAt(t, m.index) ? 'dont' : 'do', act: 'run', object: 'tests:full' }));
  m = FOCUSED_TESTS.exec(t);
  if (m) push(extra({ polarity: negatedAt(t, m.index) ? 'dont' : 'do', act: 'run', object: 'tests:focused' }));
  for (const tool of TOOLS) {
    const re = new RegExp(`(?<![\\w-])${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
    for (let mm = re.exec(t); mm; mm = re.exec(t)) {
      push(extra({ polarity: negatedAt(t, mm.index) ? 'dont' : 'do', act: 'use', object: `tool:${tool}` }));
      break;
    }
  }
  m = FORCE_PUSH.exec(t);
  if (m) push(extra({ polarity: negatedAt(t, m.index) || /\bnever\b/.test(t.slice(0, m.index)) ? 'dont' : 'do', act: 'push', object: 'git:force-push' }));
  if (REPORT.test(t)) push(extra({ polarity: 'do', act: 'report', object: 'result-summary' }));
  return out;
}

/** Identity of a claim for comparisons (exception wording excluded). */
export function claimKey(c: Claim): string {
  return `${c.polarity}|${c.act}|${c.object}|${c.when ?? '*'}`;
}

/** Same instruction: equal non-empty claim sets. */
export function sameClaims(a: readonly Claim[] | undefined, b: readonly Claim[] | undefined): boolean {
  if (!a?.length || !b?.length) return false;
  const A = new Set(a.map(claimKey));
  const B = new Set(b.map(claimKey));
  return A.size === B.size && [...A].every((k) => B.has(k));
}

/** Opposed actions under overlapping conditions: same act and object, opposite polarity, compatible conditions. */
export function opposed(a: Claim, b: Claim): boolean {
  if (a.act !== b.act || a.object !== b.object || a.polarity === b.polarity) return false;
  if (a.when && b.when && a.when !== b.when) return false;
  return true;
}
