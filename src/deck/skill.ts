import { bytes, text } from './file';
import { SKILL_FILE, SKILL_LANES } from './lanes';

export const SKILL_MAX_BYTES = 32768;
export const SKILL_BODY_TOKENS_TARGET = 400;

export interface SkillSpec {
  slug: string;
  cardId: string;
  title: string;
  description: string;
  trigger: string;
  prerequisites: string[];
  steps: string[];
  verification: string[];
  stopConditions: string[];
  provenance?: string;
}

export interface RenderedSkill {
  slug: string;
  rel: string;
  bytes: Uint8Array;
  text: string;
  bodyTokens: number;
  problems: string[];
}

export function skillSlug(raw: string): string | null {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, SKILL_FILE.nameMax).replace(/-+$/g, '');
  return slug || null;
}

function oneLine(value: string): string {
  return value.replace(/\r/g, '').replace(/[\s\u0085]+/g, ' ').trim();
}

function quoteScalar(value: string): string {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function fieldProblems(name: string | null, description: string | null): string[] {
  const problems: string[] = [];
  if (name === null) problems.push('Missing required name in frontmatter.');
  else if (!name || name.length > SKILL_FILE.nameMax || !SKILL_FILE.namePattern.test(name)) {
    problems.push('Skill name must be 1-64 lowercase letters or digits, separated by single hyphens.');
  }
  if (description === null) problems.push('Missing required description in frontmatter.');
  else {
    if (!description.trim()) problems.push('Skill description must not be empty.');
    if (description.length > SKILL_FILE.descriptionMax) problems.push('Skill description is over 1024 characters.');
  }
  return problems;
}

function sizeProblems(fileBytes: number, bodyTokens: number): string[] {
  const problems: string[] = [];
  if (fileBytes > SKILL_MAX_BYTES) problems.push(`Skill file is over ${SKILL_MAX_BYTES} bytes (${fileBytes}).`);
  if (bodyTokens > 2 * SKILL_BODY_TOKENS_TARGET) {
    problems.push(`Skill body is over ${2 * SKILL_BODY_TOKENS_TARGET} estimated tokens (${bodyTokens}); target is ${SKILL_BODY_TOKENS_TARGET}.`);
  }
  return problems;
}

/** Invalid requested names are reported, not silently renamed. */
export function renderSkill(spec: SkillSpec): RenderedSkill {
  const description = oneLine(spec.description);
  const bullets = (items: string[]) => items.map((item) => `- ${oneLine(item)}`);
  const lines = [
    `# ${oneLine(spec.title)}`, '',
    '## When to use', oneLine(spec.trigger), '',
    '## Before you start', ...bullets(spec.prerequisites), '',
    '## Steps', ...spec.steps.map((step, i) => `${i + 1}. ${oneLine(step)}`), '',
    '## Check the result', ...bullets(spec.verification), '',
    '## Stop and report when', ...bullets(spec.stopConditions),
  ];
  const provenance = oneLine(spec.provenance ?? '');
  if (provenance) lines.push('', `_${provenance}_`);
  const body = '\n' + lines.join('\n') + '\n';
  const rendered = [
    '---',
    `name: ${oneLine(spec.slug)}`,
    `description: ${quoteScalar(description)}`,
    'metadata:',
    `  deck-card: ${quoteScalar(spec.cardId)}`,
    '---',
  ].join('\n') + '\n' + body;
  const encoded = bytes(rendered);
  const bodyTokens = Math.ceil(bytes(body).length / 3);
  const problems = fieldProblems(spec.slug, description);
  if (!spec.steps.some((step) => oneLine(step))) problems.push('Skill steps list must not be empty.');
  problems.push(...sizeProblems(encoded.length, bodyTokens));
  return { slug: spec.slug, rel: `${spec.slug}/${SKILL_FILE.name}`, bytes: encoded, text: rendered, bodyTokens, problems };
}

interface Frontmatter {
  fields: Map<string, string>;
  metadata: Map<string, string>;
  body: string;
  problems: string[];
}

/** A deliberately small scalar reader, not a general YAML parser. */
function scalar(raw: string): string | null {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")[ \t]*(?:#.*)?$/.exec(value);
    if (!quoted) return null;
    try {
      return JSON.parse(quoted[1]) as string;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(value);
    return quoted ? quoted[1].replace(/''/g, "'") : null;
  }
  if (/^[\[\]{}>|&*!]/.test(value) || /:[ \t]/.test(value)) return null;
  return value.replace(/(?:^|[ \t]+)#.*$/, '').trim();
}

function frontmatter(source: string): Frontmatter {
  const out: Frontmatter = { fields: new Map(), metadata: new Map(), body: source, problems: [] };
  const match = /^---\r?\n([\s\S]*?)^---\r?(?:\n|$)/m.exec(source);
  if (!match || match.index !== 0) {
    out.problems.push('Skill file must start with YAML frontmatter closed by a --- line.');
    return out;
  }
  out.body = source.slice(match[0].length);
  const seen = new Set<string>();
  let inMetadata = false;
  for (const line of match[1].split('\n')) {
    const clean = line.replace(/\r$/, '');
    if (!clean.trim() || clean.trimStart().startsWith('#')) continue;
    const entry = /^([ ]*)([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(clean);
    if (!entry) {
      out.problems.push('Unsupported or malformed frontmatter line.');
      continue;
    }
    const [, indent, key, raw] = entry;
    if (indent) {
      if (!inMetadata) {
        out.problems.push('Indented frontmatter entries must belong to metadata.');
        continue;
      }
      if (out.metadata.has(key)) out.problems.push(`Duplicate metadata key: ${key}.`);
      const value = scalar(raw);
      if (value === null) out.problems.push(`Unsupported metadata value for ${key}.`);
      else out.metadata.set(key, value);
      continue;
    }
    if (seen.has(key)) out.problems.push(`Duplicate frontmatter key: ${key}.`);
    seen.add(key);
    inMetadata = key === 'metadata' && raw.trim() === '';
    if (key === 'metadata') {
      if (!inMetadata && raw.trim() !== '{}') out.problems.push('Frontmatter metadata must be a map.');
      continue;
    }
    const value = scalar(raw);
    if (value === null) out.problems.push(`Unsupported frontmatter value for ${key}.`);
    else out.fields.set(key, value);
  }
  return out;
}

export function validateSkillFile(source: string, dirName: string): string[] {
  const parsed = frontmatter(source);
  const name = parsed.fields.get('name') ?? null;
  const description = parsed.fields.get('description') ?? null;
  const problems = [...parsed.problems, ...fieldProblems(name, description)];
  if (name !== null && name !== dirName) problems.push('Skill name must equal its parent directory name.');
  // Other skills may use free-form Markdown; check an explicit Steps section when present.
  const steps = /(?:^|\n)## Steps[ \t]*\r?\n([\s\S]*?)(?=\n## |$)/.exec(parsed.body);
  if (steps && !/^(?:\d+\.|-)[ \t]+\S/m.test(steps[1])) problems.push('Skill steps list must not be empty.');
  const bodyTokens = Math.ceil(bytes(parsed.body).length / 3);
  problems.push(...sizeProblems(bytes(source).length, bodyTokens));
  return problems;
}

export function skillCardId(source: string): string | null {
  const parsed = frontmatter(source);
  if (parsed.problems.length) return null;
  return parsed.metadata.get('deck-card') ?? null;
}

export function skillClash(existing: Uint8Array | null, next: Uint8Array, cardId: string): 'absent' | 'identical' | 'ours' | 'foreign' {
  if (existing === null) return 'absent';
  if (existing.length === next.length && existing.every((value, i) => value === next[i])) return 'identical';
  return skillCardId(text(existing)) === cardId ? 'ours' : 'foreign';
}

export function skillTargets(r: RenderedSkill, lanes: { claude: boolean; codex: boolean }): { root: 'claude-skills' | 'codex-skills'; rel: string; kind: 'skill'; next: Uint8Array }[] {
  if (r.problems.length) throw new Error(r.problems.join(' '));
  const targets: { root: 'claude-skills' | 'codex-skills'; rel: string; kind: 'skill'; next: Uint8Array }[] = [];
  if (lanes.claude) targets.push({ root: SKILL_LANES.claude.root, rel: r.rel, kind: 'skill', next: r.bytes });
  if (lanes.codex) targets.push({ root: SKILL_LANES.codex.root, rel: r.rel, kind: 'skill', next: r.bytes });
  return targets;
}

export function pointerLine(slug: string, what: string): string {
  return `For ${oneLine(what)}, use the \`${oneLine(slug)}\` skill.`;
}
