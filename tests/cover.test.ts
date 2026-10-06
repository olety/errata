// Table-driven test of the eight-check cover rule. Each row changes one thing from a covering baseline.
import { describe, expect, test } from 'bun:test';
import { cover, coverage, evalTrigger, type Check } from '../src/cover';
import { acceptMapping, cardDigest } from '../src/deck/card';
import type { Card, Case, ExportMap } from '../src/deck/types';
import { FAMILY_KEYS } from '../src/deck/types';

const baseCard: Card = Object.freeze({
  id: 'r_test',
  type: 'rule',
  family: 'repeated-command',
  title: 'Read the error first',
  targets: 'both',
  scope: { kind: 'global' },
  trigger: { event: 'command_failed', commandPrefix: 'bun test' },
  responseKey: 'inspect_error_before_retry',
  exceptions: [],
  exceptionsReviewed: true,
  text: 'When `bun test` fails, read its error output before running it again unchanged.',
  textRevision: 1,
  acceptedMappings: {},
  evidenceRefs: [],
  taken: true,
}) as Card;

const baseCase: Case = {
  id: 'c1',
  agent: 'claude',
  projectKey: 'pA',
  projectLabel: 'api',
  facts: { event: 'command_failed', fingerprint: 'bun test src/a.test.ts', program: 'bun' },
  eligibleResponseKeys: FAMILY_KEYS['repeated-command'],
  disposition: 'issue',
  evidenceRefs: [],
};

const BOTH: ExportMap = { claude: new Set(['r_test']), codex: new Set(['r_test']) };
const accepted = (c: Card, caseId = 'c1') => acceptMapping(c, caseId);

type Row = { name: string; card?: (c: Card) => Card; kase?: (k: Case) => Case; exported?: ExportMap; covers: boolean; failing?: Check; tri?: 'false' | 'unknown' };

const rows: Row[] = [
  { name: 'baseline covers', covers: true },
  { name: '1 pivot never covers', kase: (k) => ({ ...k, disposition: 'pivot' }), covers: false, failing: 'confirmed_issue', tri: 'false' },
  { name: '1 unreviewed is unknown', kase: (k) => ({ ...k, disposition: 'unreviewed' }), covers: false, failing: 'confirmed_issue', tri: 'unknown' },
  { name: '1 not a problem', kase: (k) => ({ ...k, disposition: 'not-a-problem' }), covers: false, failing: 'confirmed_issue', tri: 'false' },
  { name: '2 not in the rendered Claude file', exported: { claude: new Set(), codex: new Set(['r_test']) }, covers: false, failing: 'in_export', tri: 'false' },
  { name: '2 a trait never exports', card: (c) => ({ ...c, type: 'trait' }) as Card, covers: false, failing: 'in_export', tri: 'false' },
  { name: '3 wrong agent', card: (c) => ({ ...c, targets: 'codex' }) as Card, covers: false, failing: 'targets_agent', tri: 'false' },
  { name: '4 wrong project identity with the same label', card: (c) => ({ ...c, scope: { kind: 'project', projectKey: 'pB', label: 'api' } }) as Card, covers: false, failing: 'scope_matches', tri: 'false' },
  { name: '4 unknown project vs project scope', card: (c) => ({ ...c, scope: { kind: 'project', projectKey: 'pA', label: 'api' } }) as Card, kase: (k) => ({ ...k, projectKey: null }), covers: false, failing: 'scope_matches', tri: 'unknown' },
  { name: '4 same project identity covers', card: (c) => ({ ...c, scope: { kind: 'project', projectKey: 'pA', label: 'api' } }) as Card, covers: true },
  { name: '5 other command', kase: (k) => ({ ...k, facts: { ...k.facts, fingerprint: 'bun testx' } }), covers: false, failing: 'trigger_true', tri: 'false' },
  { name: '5 missing fingerprint is unknown', kase: (k) => ({ ...k, facts: { event: 'command_failed' } }), covers: false, failing: 'trigger_true', tri: 'unknown' },
  { name: '5 missing event is unknown', kase: (k) => ({ ...k, facts: {} }), covers: false, failing: 'trigger_true', tri: 'unknown' },
  { name: '6 response not eligible', kase: (k) => ({ ...k, eligibleResponseKeys: FAMILY_KEYS.boundary }), covers: false, failing: 'response_eligible', tri: 'false' },
  { name: '7 exceptions not reviewed', card: (c) => ({ ...c, exceptionsReviewed: false }) as Card, covers: false, failing: 'exceptions_clear', tri: 'unknown' },
  { name: '7 an exception excludes the case', card: (c) => ({ ...c, exceptions: [{ text: 'not in api', when: { projectKey: 'pA' } }] }) as Card, covers: false, failing: 'exceptions_clear', tri: 'false' },
  { name: '7 an exception for another project leaves it clear', card: (c) => ({ ...c, exceptions: [{ text: 'not in web', when: { projectKey: 'pZ' } }] }) as Card, covers: true },
  { name: '7 an exception with no predicate is unknown', card: (c) => ({ ...c, exceptions: [{ text: 'vague', when: {} }] }) as Card, covers: false, failing: 'exceptions_clear', tri: 'unknown' },
  { name: '8 never accepted is unknown', card: (c) => ({ ...c, acceptedMappings: {} }) as Card, covers: false, failing: 'mapping_accepted', tri: 'unknown' },
  { name: '8 edited after acceptance', card: (c) => ({ ...c, text: c.text + ' Always.' }) as Card, covers: false, failing: 'mapping_accepted', tri: 'false' },
  { name: '8 accepted for another case only', card: (c) => ({ ...c, acceptedMappings: { other: cardDigest(c) } }) as Card, covers: false, failing: 'mapping_accepted', tri: 'unknown' },
];

describe('cover rule table', () => {
  for (const r of rows) {
    test(r.name, () => {
      // Field edits are applied, then acceptance is taken on the card as the player saw it — except for rows that
      // test acceptance itself, where the edit happens after acceptance.
      const editAfter = r.name.startsWith('8');
      let card = editAfter ? accepted(baseCard) : r.card ? r.card(baseCard) : baseCard;
      if (!editAfter) card = accepted(card);
      if (editAfter && r.card) card = r.card(card);
      const k = r.kase ? r.kase(baseCase) : baseCase;
      const res = cover(card, k, r.exported ?? BOTH);
      expect(res.covers).toBe(r.covers);
      if (r.failing) expect(res.checks[r.failing]).toBe(r.tri!);
    });
  }
});

describe('boundary triggers', () => {
  test('a boundary card covers only its own constraint; an unnamed one is unknown unless approved as generic', () => {
    const facts = { event: 'resume_after_interrupt' as const, constraintKey: 'keep public api names' };
    expect(evalTrigger({ event: 'resume_after_interrupt', constraintKey: 'keep public api names' }, facts)).toBe('true');
    expect(evalTrigger({ event: 'resume_after_interrupt', constraintKey: 'do not edit auth' }, facts)).toBe('false');
    expect(evalTrigger({ event: 'resume_after_interrupt', constraintKey: 'do not edit auth' }, { event: 'resume_after_interrupt' })).toBe('unknown');
    expect(evalTrigger({ event: 'resume_after_interrupt' }, facts)).toBe('unknown');
    expect(evalTrigger({ event: 'resume_after_interrupt', generic: true }, facts)).toBe('true');
  });
});

test('coverage counts confirmed issues only', () => {
  const card = accepted(accepted(baseCard), 'c2');
  const cases: Case[] = [baseCase, { ...baseCase, id: 'c2', agent: 'codex' }, { ...baseCase, id: 'c3', disposition: 'pivot' }, { ...baseCase, id: 'c4' }];
  const cov = coverage([card], cases, BOTH);
  expect(cov.confirmed).toBe(3);
  expect(cov.addressed).toBe(2);
});

test('coverage counts one pip per family per session', () => {
  const card = accepted(accepted(accepted(baseCard), 'c2'), 'c3');
  const ref = (sessionId: string) => [{ sessionId, agent: 'claude' as const, turn: 1, callId: null }];
  const cases: Case[] = [
    { ...baseCase, family: 'repeated-command', evidenceRefs: ref('s1') },
    { ...baseCase, id: 'c2', family: 'repeated-command', evidenceRefs: ref('s1') },
    { ...baseCase, id: 'c3', family: 'repeated-command', evidenceRefs: ref('s2'), facts: { event: 'command_failed', fingerprint: 'make' } },
  ];
  const cov = coverage([card], cases, BOTH);
  expect(cov.confirmed).toBe(2);
  expect(cov.addressed).toBe(1);
});
