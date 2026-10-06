import { describe, expect, test } from 'bun:test';
import { bytes } from '../src/deck/file';
import {
  SKILL_MAX_BYTES, SKILL_BODY_TOKENS_TARGET,
  skillSlug, renderSkill, validateSkillFile, skillCardId, skillClash, skillTargets, pointerLine,
  type SkillSpec,
} from '../src/deck/skill';

const example: SkillSpec = {
  "slug": "verify-change",
  "cardId": "s_42e",
  "title": "Verify a change",
  "description": "Check a code change before reporting it done: run the focused test, review the diff, report the result with its pass count.",
  "trigger": "After editing code to fix a failing test or a reported bug, before saying the work is done.",
  "prerequisites": [
    "The test file or test id that covers the change is known."
  ],
  "steps": [
    "Run only the focused test for the change.",
    "Read the output; continue only if it passes.",
    "Run git diff --stat, then git diff, and check every changed line belongs to the task.",
    "Report what changed and the test result with its pass count."
  ],
  "verification": [
    "The focused test passed in this session.",
    "The diff contains only the intended files."
  ],
  "stopConditions": [
    "The focused test still fails after one targeted fix.",
    "The diff touches files outside the task."
  ],
  "provenance": "Reviewed from 2 sessions (Claude Code, Codex)."
};

function bodyOf(source: string): string {
  const end = source.indexOf('\n---\n');
  return source.slice(end + '\n---\n'.length);
}

function hasProblem(problems: string[], fragment: string): boolean {
  return problems.some((problem) => problem.includes(fragment));
}

describe('skillSlug', () => {
  test('normalises runs, case, symbols and mixed Unicode', () => {
    expect(skillSlug('  Verify__CHANGE / tests!  ')).toBe('verify-change-tests');
    expect(skillSlug('Café ✅ tests')).toBe('caf-tests');
    expect(skillSlug('verify-change')).toBe('verify-change');
    for (const raw of ['', '   ', '---!@#$%^&*()', '你好 ✨', 'éüø']) expect(skillSlug(raw)).toBeNull();
  });

  test('cuts at 64 without leaving a trailing hyphen', () => {
    expect(skillSlug('A'.repeat(70))).toBe('a'.repeat(64));
    expect(skillSlug('a'.repeat(63) + '--extra')).toBe('a'.repeat(63));
    expect(skillSlug('a'.repeat(64))).toBe('a'.repeat(64));
  });
});

describe('renderSkill', () => {
  test('renders the reviewed example in the required order and validates its directory name', () => {
    const r = renderSkill(example);
    expect(r.slug).toBe('verify-change');
    expect(r.rel).toBe('verify-change/SKILL.md');
    expect(r.problems).toEqual([]);
    expect(validateSkillFile(r.text, r.slug)).toEqual([]);
    expect(hasProblem(validateSkillFile(r.text, 'other-skill'), 'parent directory')).toBe(true);
    expect(r.text.split('\n').slice(0, 6)).toEqual([
      '---', 'name: verify-change', `description: ${JSON.stringify(example.description)}`,
      'metadata:', '  deck-card: "s_42e"', '---',
    ]);
    const body = bodyOf(r.text);
    const headings = body.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual([
      '# Verify a change', '## When to use', '## Before you start', '## Steps',
      '## Check the result', '## Stop and report when',
    ]);
    expect(body.split('\n').filter((line) => /^\d+\./.test(line)))
      .toEqual(example.steps.map((step, i) => `${i + 1}. ${step}`));
    expect(r.text.endsWith('_Reviewed from 2 sessions (Claude Code, Codex)._\n')).toBe(true);
    expect(r.text.endsWith('\n\n')).toBe(false);
    expect(r.bytes).toEqual(bytes(r.text));
    expect(r.bodyTokens).toBe(Math.ceil(bytes(body).length / 3));
  });

  test('a realistic five-step workflow stays near the 400-token body target', () => {
    const r = renderSkill({
      ...example,
      steps: [
        'Confirm the focused test covers the reported bug, including the failing input and the expected result.',
        "Run only the focused test for the change with the project's documented command; keep the exact command and pass count.",
        'Read the output and confirm the test passed in this session. If it fails, stop after one targeted fix rather than widening the task.',
        'Run git diff --stat, then git diff. Check every changed line belongs to the task, and make sure no unrelated files or secrets were added.',
        'Report the change, the exact test command, its pass count, and any check that was not run. Do not claim success beyond the evidence.',
      ],
    });
    expect(r.problems).toEqual([]);
    expect(r.bodyTokens).toBeGreaterThanOrEqual(SKILL_BODY_TOKENS_TARGET * 0.8);
    expect(r.bodyTokens).toBeLessThanOrEqual(SKILL_BODY_TOKENS_TARGET * 1.2);
  });

  test('reports invalid requested names without silently renaming them', () => {
    for (const slug of ['', 'Bad-Name', '-bad', 'bad-', 'bad--name', 'a'.repeat(65), '你好', '../other']) {
      const r = renderSkill({ ...example, slug });
      expect(r.slug).toBe(slug);
      expect(hasProblem(r.problems, 'name')).toBe(true);
    }
    expect(renderSkill({ ...example, slug: 'a'.repeat(64) }).problems).toEqual([]);
  });

  test('enforces description bounds and an empty steps list', () => {
    for (const character of ['d', '🙂']) {
      const atLimit = renderSkill({ ...example, description: character.repeat(1024) });
      expect(atLimit.problems).toEqual([]);
      expect(validateSkillFile(atLimit.text, atLimit.slug)).toEqual([]);
      const long = renderSkill({ ...example, description: character.repeat(1025) });
      expect(hasProblem(long.problems, 'over 1024 characters')).toBe(true);
      expect(hasProblem(validateSkillFile(long.text, long.slug), 'over 1024 characters')).toBe(true);
    }
    expect(hasProblem(renderSkill({ ...example, description: ' \r\n ' }).problems, 'description must not be empty')).toBe(true);
    const empty = renderSkill({ ...example, steps: [] });
    expect(hasProblem(empty.problems, 'steps list must not be empty')).toBe(true);
    expect(hasProblem(validateSkillFile(empty.text, empty.slug), 'steps list must not be empty')).toBe(true);
  });

  test('flags a 40,000-byte step and measures UTF-8 bytes, not character count', () => {
    expect(SKILL_MAX_BYTES).toBe(32768);
    for (const step of ['x'.repeat(40000), '漢'.repeat(14000)]) {
      const r = renderSkill({ ...example, steps: [step] });
      expect(hasProblem(r.problems, 'over 32768 bytes')).toBe(true);
      expect(hasProblem(r.problems, 'over 800 estimated tokens')).toBe(true);
      expect(hasProblem(validateSkillFile(r.text, r.slug), 'over 32768 bytes')).toBe(true);
      expect(r.bodyTokens).toBe(Math.ceil(bytes(bodyOf(r.text)).length / 3));
    }
  });

  test('returns a file and every broken rule rather than stopping at the first problem', () => {
    const r = renderSkill({ ...example, slug: 'Bad--Name', description: 'd'.repeat(1025), title: 'x'.repeat(40000), steps: [] });
    expect(r.problems).toHaveLength(5);
    for (const fragment of ['name', 'over 1024 characters', 'steps list', 'over 32768 bytes', 'over 800 estimated tokens']) {
      expect(hasProblem(r.problems, fragment)).toBe(true);
    }
    expect(r.bytes.length).toBeGreaterThan(SKILL_MAX_BYTES);
  });

  test('collapses CRLF and multiline inputs without injecting frontmatter or list lines', () => {
    const r = renderSkill({
      ...example, title: 'Verify\r\na change', description: 'First\r\n---\nsecond',
      cardId: 's_42e"\\\r\n---', trigger: 'After editing\r\ncode.',
      prerequisites: ['Know\r\nthe test.'], steps: ['Run\r\nthe test.\n---\nReport.'],
      verification: ['Test\npasses.'], stopConditions: ['Test\r\nfails.'],
      provenance: 'Reviewed\r\nfrom 2 sessions.',
    });
    expect(r.text).not.toContain('\r');
    expect(r.text.split('\n').filter((line) => line === '---')).toHaveLength(2);
    expect(r.text).toContain('# Verify a change\n');
    expect(r.text).toContain('description: "First --- second"\n');
    expect(r.text).toContain('After editing code.\n');
    expect(r.text).toContain('- Know the test.\n');
    expect(r.text).toContain('1. Run the test. --- Report.\n');
    expect(r.text).toContain('- Test passes.\n');
    expect(r.text).toContain('- Test fails.\n');
    expect(r.text).toContain('_Reviewed from 2 sessions._\n');
    expect(validateSkillFile(r.text, r.slug)).toEqual([]);
    expect(skillCardId(r.text)).toBe('s_42e"\\\r\n---');
    expect(validateSkillFile(r.text.replace(/\n/g, '\r\n'), r.slug)).toEqual([]);
  });

  test('quotes, backslashes and --- in a description survive round-trip parsing', () => {
    const description = 'Run "focused" checks --- then report \\ and the result.';
    const r = renderSkill({ ...example, description });
    const line = r.text.split('\n')[2];
    expect(JSON.parse(line.slice('description: '.length))).toBe(description);
    expect(validateSkillFile(r.text, r.slug)).toEqual([]);
  });

  test('is deterministic and omits absent or blank provenance', () => {
    const a = renderSkill(example);
    const b = renderSkill({ ...example, steps: [...example.steps] });
    expect(a).toEqual(b);
    const absent = renderSkill({ ...example, provenance: undefined });
    expect(absent.text).not.toContain('_Reviewed');
    expect(absent.text.endsWith('\n')).toBe(true);
    expect(absent.text.endsWith('\n\n')).toBe(false);
    expect(renderSkill({ ...example, provenance: ' \r\n ' })).toEqual(absent);
  });
});

describe('validateSkillFile', () => {
  test('accepts simple plain and quoted fields with an optional metadata map', () => {
    const fixtures = [
      '---\nname: verify-change\ndescription: Check a change --- before reporting it done.\n---\n# Verify\n',
      '---\nname: "verify-change"\ndescription: "Check a change." # comment\nmetadata:\n  deck-card: s_42e\n---\n# Verify\n',
      "---\nname: 'verify-change'\ndescription: 'Check it''s done.'\nmetadata: {}\n---\n# Verify\n",
    ];
    for (const source of fixtures) expect(validateSkillFile(source, 'verify-change')).toEqual([]);
  });

  test('returns problems for malformed or missing frontmatter without throwing', () => {
    const fixtures = [
      '', '# No frontmatter', '---\nname: verify-change\n',
      '---\nname: verify-change\n---\n',
      '---\ndescription: Check it.\n---\n',
      '---\nname: Bad--Name\ndescription: ""\n---\n',
      '---\nname: verify-change\ndescription: "unterminated\n---\n',
      '---\nname: verify-change\ndescription: "bad\\q"\n---\n',
      '---\nname: verify-change\ndescription: Check it.\nname: verify-change\n---\n',
      '---\nname: verify-change\ndescription: Check it.\nmetadata: []\n---\n',
      '---\nname: verify-change\ndescription: Check it.\n  deck-card: s_42e\n---\n',
    ];
    for (const source of fixtures) {
      expect(() => validateSkillFile(source, 'verify-change')).not.toThrow();
      expect(validateSkillFile(source, 'verify-change').length).toBeGreaterThan(0);
    }
  });

  test('allows exactly twice the body token target and rejects the next UTF-8 byte', () => {
    const front = '---\nname: verify-change\ndescription: Check it.\n---\n';
    const atLimit = front + '漢'.repeat(800);
    expect(validateSkillFile(atLimit, 'verify-change')).toEqual([]);
    expect(hasProblem(validateSkillFile(atLimit + 'x', 'verify-change'), 'over 800 estimated tokens')).toBe(true);
  });
});

describe('skill identity and Apply planning', () => {
  test('reads only metadata deck-card, round-trips escaped ids and returns null for other text', () => {
    expect(skillCardId(renderSkill(example).text)).toBe(example.cardId);
    const id = 's_42e"\\\nnext';
    expect(skillCardId(renderSkill({ ...example, cardId: id }).text)).toBe(id);
    for (const source of [
      '', '# metadata:\n  deck-card: "s_42e"\n',
      '---\nname: verify-change\ndescription: Check it.\n---\nmetadata:\n  deck-card: "s_42e"\n',
      '---\nname: verify-change\ndescription: Check it.\ndeck-card: "s_42e"\n---\n',
      '---\nmetadata:\n  deck-card: "unterminated\n---\n',
    ]) expect(skillCardId(source)).toBeNull();
  });

  test('escapes Unicode line separators in metadata without losing the card id', () => {
    const cardId = 's_42e\u0085next\u2028---\u2029"\\end';
    const r = renderSkill({ ...example, cardId, description: 'Check\u0085a\u2028change\u2029now.' });
    expect(r.problems).toEqual([]);
    expect(r.text).not.toMatch(/[\u0085\u2028\u2029]/);
    expect(validateSkillFile(r.text, r.slug)).toEqual([]);
    expect(skillCardId(r.text)).toBe(cardId);
  });

  test('distinguishes absent, identical, ours and foreign in that order', () => {
    const next = renderSkill(example).bytes;
    expect(skillClash(null, next, example.cardId)).toBe('absent');
    expect(skillClash(next.slice(), next, 'different-id')).toBe('identical');
    const ours = renderSkill({ ...example, title: 'Verify the edited change' }).bytes;
    expect(skillClash(ours, next, example.cardId)).toBe('ours');
    const foreign = renderSkill({ ...example, cardId: 's_other' }).bytes;
    expect(skillClash(foreign, next, example.cardId)).toBe('foreign');
    expect(skillClash(bytes('Unmanaged file'), next, example.cardId)).toBe('foreign');
    expect(skillClash(new Uint8Array(0), next, example.cardId)).toBe('foreign');
  });

  test('plans both roots, either root or none, with skill bodies', () => {
    const r = renderSkill(example);
    const claude = { root: 'claude-skills', rel: r.rel, kind: 'skill', next: r.bytes } as const;
    const codex = { root: 'codex-skills', rel: r.rel, kind: 'skill', next: r.bytes } as const;
    expect(skillTargets(r, { claude: true, codex: true })).toEqual([claude, codex]);
    expect(skillTargets(r, { claude: true, codex: false })).toEqual([claude]);
    expect(skillTargets(r, { claude: false, codex: true })).toEqual([codex]);
    expect(skillTargets(r, { claude: false, codex: false })).toEqual([]);
  });

  test('refuses rendered problems even when no roots are enabled', () => {
    const bad = renderSkill({ ...example, steps: [] });
    expect(() => skillTargets(bad, { claude: true, codex: true })).toThrow();
    expect(() => skillTargets(bad, { claude: false, codex: false })).toThrow();
  });

  test('produces the one-line global pointer', () => {
    expect(pointerLine('verify-change', 'checking a code change'))
      .toBe('For checking a code change, use the `verify-change` skill.');
    expect(pointerLine('verify-change', 'checking\r\na code\nchange'))
      .toBe('For checking a code change, use the `verify-change` skill.');
  });
});
