// Read-only run over the local machine's real session logs, for the hour-12 checks.
// Reads ONLY <home>/.claude/projects/**/*.jsonl and <home>/.codex/sessions/**/rollout-*.jsonl.
// Writes only under --out, which must be outside this repository. Everything printed or written has passed
// through the parse-time redactor; the raw cross-check prints counts only.
//
//   bun scripts/real-run.ts --out <dir outside the repo> [--days 14] [--per-agent 12]

import { Glob } from 'bun';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseSessionFile } from '../src/parse/index';
import type { Session } from '../src/model';
import { allCalls } from '../src/model';
import { detectEpisodes, mirror, type Episode } from '../src/episodes';
import { draftCards, groupRooms, type Room } from '../src/deck/templates';
import { lineWeight } from '../src/deck/file';

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = resolve(arg('--out') ?? '');
const DAYS = Number(arg('--days', '14'));
const PER = Number(arg('--per-agent', '12'));
const REPO = resolve(import.meta.dir, '..');
if (!arg('--out') || !relative(REPO, OUT).startsWith('..')) {
  console.error('--out must be a directory outside the repository');
  process.exit(2);
}

const HOME = homedir();
const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects');
const CODEX_SESSIONS = join(HOME, '.codex', 'sessions');
const since = Date.now() - DAYS * 86400_000;

async function newest(root: string, pattern: string, keep: (rel: string) => boolean): Promise<{ abs: string; rel: string; mtime: number; size: number }[]> {
  const out: { abs: string; rel: string; mtime: number; size: number }[] = [];
  for await (const rel of new Glob(pattern).scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
    if (!keep(rel)) continue;
    const abs = join(root, rel);
    const st = await stat(abs);
    if (st.mtimeMs >= since) out.push({ abs, rel, mtime: st.mtimeMs, size: st.size });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Claude Code: top-level session files only (subagent threads live under <session>/subagents/).
const ccFiles = await newest(CLAUDE_PROJECTS, '*/*.jsonl', (rel) => rel.split('/').length === 2);
// Codex: rollouts only.
const cxFiles = await newest(CODEX_SESSIONS, '**/rollout-*.jsonl', (rel) => /(^|\/)rollout-[^/]*\.jsonl$/.test(rel));

async function pick(files: { abs: string; rel: string }[], n: number): Promise<{ sessions: Session[]; skippedAgentAuthored: number; considered: number }> {
  const sessions: Session[] = [];
  let skipped = 0;
  let considered = 0;
  for (const f of files) {
    if (sessions.length >= n) break;
    considered++;
    const s = await parseSessionFile({ rel: f.rel, blob: Bun.file(f.abs) });
    if (s.agentAuthored) {
      skipped++;
      continue;
    }
    sessions.push(s);
  }
  return { sessions, skippedAgentAuthored: skipped, considered };
}

const cc = await pick(ccFiles, PER);
const cx = await pick(cxFiles, PER);
const sessions = [...cc.sessions, ...cx.sessions];

// ---- independent raw cross-check (counts only): call ids and result ids straight from the JSON rows
type Raw = { calls: Set<string>; results: Set<string>; paired: number; interrupts: number; userRows: number };
async function rawCounts(s: Session, abs: string): Promise<Raw | null> {
  if (s.partial) return null; // tail windows are not comparable
  const calls = new Set<string>();
  const results = new Set<string>();
  let interrupts = 0;
  let userRows = 0;
  const text = await Bun.file(abs).text();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (s.agent === 'claude') {
      const c = o?.message?.content;
      if (o.type === 'assistant' && Array.isArray(c)) for (const b of c) if (b?.type === 'tool_use') calls.add(b.id);
      if (o.type === 'user' && Array.isArray(c)) for (const b of c) if (b?.type === 'tool_result') results.add(b.tool_use_id);
      if (o.type === 'user') userRows++;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
      if (o.type === 'user' && /^\s*\[Request interrupted by user/.test(t)) interrupts++;
    } else {
      const p = o?.payload;
      if (o.type === 'response_item' && (p?.type === 'function_call' || p?.type === 'custom_tool_call')) calls.add(p.call_id);
      if (o.type === 'response_item' && (p?.type === 'function_call_output' || p?.type === 'custom_tool_call_output')) results.add(p.call_id);
      if (o.type === 'event_msg' && p?.type === 'turn_aborted' && (p.reason ?? 'interrupted') === 'interrupted') interrupts++;
      if (o.type === 'response_item' && p?.type === 'message' && p.role === 'user') userRows++;
    }
  }
  let paired = 0;
  for (const id of calls) if (results.has(id)) paired++;
  return { calls, results, paired, interrupts, userRows };
}

const absOf = new Map<string, string>();
for (const f of [...ccFiles, ...cxFiles]) absOf.set(f.rel.split('/').pop()!, f.abs);

const checks: string[] = [];
let pairingOk = true;
let interruptOk = true;
const perSession: string[] = [];
for (const s of sessions) {
  const raw = await rawCounts(s, absOf.get(s.file)!);
  const calls = allCalls(s);
  // Compare by id: the parsed calls that correspond to raw call rows, and how many of them carry a result.
  const top = raw ? calls.filter((c) => raw.calls.has(c.callId)) : calls.filter((c) => c.parentCallId === null);
  const parsedPaired = raw ? top.filter((c) => c.result !== null && raw.results.has(c.callId)).length : top.filter((c) => c.result !== null).length;
  const interrupts = s.turns.filter((t) => t.role === 'interrupt').length;
  const roles = (['human', 'assistant', 'injected', 'interrupt'] as const).map((r) => `${{ human: 'h', assistant: 'a', injected: 'q', interrupt: 'x' }[r]}${s.turns.filter((t) => t.role === r).length}`).join(' ');
  if (raw) {
    if (raw.paired !== parsedPaired || raw.calls.size !== top.length) pairingOk = false;
    if (raw.interrupts !== interrupts) interruptOk = false;
  }
  perSession.push(
    `| ${s.agent} | ${s.client ?? '?'} | ${s.partial ? s.partialReason : 'full'} | ${roles} | ${top.length}/${raw?.calls.size ?? '–'} | ${parsedPaired}/${raw?.paired ?? '–'} | ${s.stats.orphanResults} | ${interrupts}/${raw?.interrupts ?? '–'} | ${Object.values(s.stats.redactions).reduce((a, b) => a + b, 0)} |`,
  );
}
checks.push(`Pairing matches an independent raw count on every full session: ${pairingOk ? 'PASS' : 'FAIL'}`);
checks.push(`Interrupt markers match an independent raw count on every full session: ${interruptOk ? 'PASS' : 'FAIL'}`);

const episodes: Episode[] = sessions.flatMap(detectEpisodes);
const m = mirror(sessions);
const rooms = groupRooms(episodes);

// ---- candidate cards: up to five. Rooms with typed (not pasted) words first, then support.
const PLACEHOLDER = '«the constraint, in your words»';
function bestEpisode(r: Room): Episode {
  const score = (e: Episode) => (e.type === 'interrupt' ? (e.receipt.quote ? (e.pasted ? 1 : 3) : 0) : 2);
  return [...r.episodes].sort((a, b) => score(b) - score(a))[0]!;
}
function rank(rs: Room[]): Room[] {
  const typed = (r: Room) => (r.family === 'repeated-command' ? 1 : r.episodes.some((e) => e.type === 'interrupt' && e.receipt.quote && !e.pasted) ? 1 : 0);
  return [...rs].sort((a, b) => typed(b) - typed(a) || b.sessions - a.sessions || b.episodes.length - a.episodes.length);
}
function pickRooms(rs: Room[], n: number): Room[] {
  const ranked = rank(rs);
  const cmd = ranked.filter((r) => r.family === 'repeated-command').slice(0, 2);
  const stops = ranked.filter((r) => r.family === 'boundary');
  return rank([...cmd, ...stops]).slice(0, n);
}
const boundaryRooms = rooms.filter((r) => r.family === 'boundary');
const commandRooms = rooms.filter((r) => r.family === 'repeated-command');
const chosen = pickRooms(rooms, 5);

// ---- wider search (script only): every top-level session in the window, read in full, for candidate supply.
const WIDE = args.includes('--wide');
let wide: { sessions: Session[]; rooms: Room[]; mirror: ReturnType<typeof mirror>; skipped: number; considered: number } | null = null;
if (WIDE) {
  const picked = new Set(sessions.map((x) => x.file));
  const all: Session[] = [...sessions.filter((x) => !x.partial)];
  let skipped = 0;
  let considered = 0;
  for (const f of [...ccFiles, ...cxFiles]) {
    const name = f.rel.split('/').pop()!;
    const already = sessions.find((x) => x.file === name);
    if (already && !already.partial) continue;
    considered++;
    if (name.startsWith('rollout-')) {
      // Header check first: subagent threads are skipped without reading the whole rollout.
      const head = await Bun.file(f.abs).slice(0, 1 << 20).text();
      const first = head.split('\n')[0] ?? '';
      try {
        const o = JSON.parse(first);
        const src = o?.payload?.source;
        if (src && typeof src === 'object' && 'subagent' in src) {
          skipped++;
          continue;
        }
      } catch {
        /* fall through to a full parse */
      }
    }
    const x = await parseSessionFile({ rel: f.rel, blob: Bun.file(f.abs) }, undefined, { fullRead: true });
    if (x.agentAuthored) {
      skipped++;
      continue;
    }
    all.push(x);
    picked.add(name);
  }
  const eps = all.flatMap(detectEpisodes);
  wide = { sessions: all, rooms: groupRooms(eps), mirror: mirror(all), skipped, considered };
}

function candidateBlock(md: string[], list: Room[], startAt: number): void {
  list.forEach((r, i) => {
    const e = bestEpisode(r);
    const scope = r.projectLabel ? `global (seen in ${r.projectLabel})` : 'global';
    const cards = draftCards(r, { boundary: r.family === 'boundary' ? PLACEHOLDER : null });
    md.push('');
    md.push(`### ${startAt + i}. ${r.name} — ${r.family === 'boundary' ? 'Boundary intervention' : 'Repeated unsuccessful command'}`);
    md.push('');
    md.push(`${r.subtitle}. Agents: ${r.agents.join(', ')}. Supporting sessions: ${r.sessions}. Scope: ${scope}.`);
    md.push('');
    const pasted = e.type === 'interrupt' && e.pasted ? ' (pasted text, shortened)' : '';
    md.push(`- **Your words:** ${e.receipt.quote ? `“${e.receipt.quote}”${pasted}` : 'Tool evidence only'}`);
    md.push(`- **The action:** ${e.receipt.action ?? 'none recorded'}`);
    md.push(`- **The result:** ${e.receipt.result ?? 'none recorded'}`);
    if (r.episodes.length > 1) {
      const others = r.episodes.filter((x) => x !== e && x.receipt.quote).slice(0, 2);
      for (const o of others) md.push(`- **Another case:** “${o.receipt.quote!.slice(0, 120)}”`);
    }
    md.push('');
    md.push('| Draft | Text | Weight (est. tokens) |');
    md.push('|---|---|---|');
    for (const c of cards) md.push(`| ${c.title} | ${c.text.replace(/\|/g, '\\|')} | ${lineWeight(c.text, c.id)} |`);
  });
}

const md: string[] = [];
const ts = new Date().toISOString();
md.push(`# Real-card candidates (read-only run, ${ts})`);
md.push('');
md.push('Aggregates and short redacted quotes only. Each card is a draft from the deterministic templates. Accept or reject in words; the boundary drafts take your own wording of the constraint.');
md.push('');
md.push('## Mirror (with denominators)');
md.push('');
md.push(`| Measure | Value |`);
md.push(`|---|---|`);
md.push(`| Sessions in the run | ${m.sessions.total} of the newest top-level sessions in ${DAYS} days (Claude Code ${m.sessions.claude} of ${ccFiles.length}, Codex ${m.sessions.codex} of ${cxFiles.length}) |`);
md.push(`| Agent-authored threads skipped while picking | Claude Code ${cc.skippedAgentAuthored} of ${cc.considered} considered, Codex ${cx.skippedAgentAuthored} of ${cx.considered} considered |`);
md.push(`| Partial sessions (tail window or cut line) | ${m.sessions.partial} of ${m.sessions.total} |`);
md.push(`| Genuine human turns | ${m.humanTurns} (injected user-role turns quarantined: ${m.injectedTurns}) |`);
md.push(`| Interrupts paired with your next message | ${m.interruptPairs} of ${m.interrupts} interrupts |`);
md.push(`| Repeated unchanged failing commands | ${m.repeatedCommand.episodes} episodes in ${m.repeatedCommand.sessionsWith} of ${m.sessions.total} sessions (failed shell runs: ${m.repeatedCommand.failedShellCalls} of ${m.repeatedCommand.shellCalls}) |`);
md.push(`| Calls with a paired result | ${m.calls.withResult} of ${m.calls.total} (orphan results: ${m.calls.orphanResults}) |`);
md.push(`| Secrets redacted at parse time | ${m.redactions} |`);
md.push(`| Projects seen | ${m.projects.length} |`);
md.push(`| Rooms (family + object + project) | ${rooms.length}: ${boundaryRooms.length} stop rooms, ${commandRooms.length} retry rooms |`);
md.push('');
md.push('Every case below starts unreviewed. Nothing is a problem until you say so; a change of mind is a pivot, not a correction.');
md.push('');
// Five candidates in total. Retry rooms carry their own evidence. Stops grouped by the interrupted tool mix
// unrelated messages, so stop candidates are single anchored episodes whose typed reply states a constraint
// (negation / "only" words: a discovery aid for ranking, never a problem verdict).
const pool = wide ? wide.rooms : rooms;
const retry = rank(pool.filter((r) => r.family === 'repeated-command')).slice(0, 2);
const DIRECTIVE = /\b(don'?t|dont|never|only|stop|without|not|no,|leave|keep|instead)\b/i;
const stopEps = pool
  .filter((r) => r.family === 'boundary')
  .flatMap((r) => r.episodes)
  .filter((e): e is Extract<Episode, { type: 'interrupt' }> => e.type === 'interrupt' && !!e.receipt.quote && !e.pasted && DIRECTIVE.test(e.receipt.quote))
  .sort((a, b) => (b.receipt.quote!.match(new RegExp(DIRECTIVE, 'gi'))?.length ?? 0) - (a.receipt.quote!.match(new RegExp(DIRECTIVE, 'gi'))?.length ?? 0) || a.receipt.quote!.length - b.receipt.quote!.length);
const stopRooms: Room[] = stopEps.slice(0, 5 - retry.length).map((e) => ({
  family: 'boundary',
  object: e.interruptedCall?.name ?? 'a reply',
  projectKey: e.projectKey,
  projectLabel: e.projectLabel,
  agents: [e.agent],
  episodes: [e],
  sessions: 1,
  name: 'The stop',
  subtitle: `You stopped the agent${e.interruptedCall ? ` during ${e.interruptedCall.name}` : ''}, then stated a constraint`,
}));
md.push('## Candidates');
md.push('');
md.push(`Drawn from ${wide ? 'the wider search' : 'the 24-session run'}. ${stopEps.length} typed stop replies carried constraint words (don't, never, only, stop, without, keep, instead…) out of ${pool.flatMap((r) => r.episodes).filter((e) => e.type === 'interrupt').length} paired stops. For a stop card, option A takes your own wording of the constraint; B and C are generic and need your approval as generic.`);
candidateBlock(md, [...retry, ...stopRooms], 1);
if (wide) {
  const wm = wide.mirror;
  md.push('');
  md.push(`## Wider search: every top-level session in ${DAYS} days, read in full`);
  md.push('');
  md.push(`The browser reads big sessions through an 8 MiB tail window; this script read them whole for candidate supply. Sessions: ${wm.sessions.total} (Claude Code ${wm.sessions.claude}, Codex ${wm.sessions.codex}; agent-authored threads skipped: ${wide.skipped} of ${wide.considered} considered). Interrupts paired with your next message: ${wm.interruptPairs} of ${wm.interrupts}. Repeated unchanged failing commands: ${wm.repeatedCommand.episodes} episodes in ${wm.repeatedCommand.sessionsWith} of ${wm.sessions.total} sessions. Rooms by family + object + project: ${wide.rooms.length}.`);
}
md.push('');
md.push('## Hour-12 checks on this run');
md.push('');
for (const c of checks) md.push(`- ${c}`);
md.push('');
md.push('## Per-session pairing (parsed / raw)');
md.push('');
md.push('| Agent | Client | Read | Turns (h human, a assistant, q quarantined, x interrupt) | Calls | Paired | Orphans | Interrupts | Redactions |');
md.push('|---|---|---|---|---|---|---|---|---|');
md.push(...perSession);

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'real-cards.md'), md.join('\n') + '\n');
await writeFile(join(OUT, 'mirror.json'), JSON.stringify({ ts, mirror: m, checks, rooms: rooms.map((r) => ({ family: r.family, sessions: r.sessions, episodes: r.episodes.length, agents: r.agents })) }, null, 2));
console.log(checks.join('\n'));
if (wide) console.log('wide', JSON.stringify({ sessions: wide.mirror.sessions, interrupts: wide.mirror.interrupts, pairs: wide.mirror.interruptPairs, repeated: wide.mirror.repeatedCommand, rooms: wide.rooms.length }));
console.log(JSON.stringify({ sessions: m.sessions, interrupts: m.interrupts, pairs: m.interruptPairs, repeated: m.repeatedCommand, calls: m.calls, redactions: m.redactions, rooms: rooms.length }));
