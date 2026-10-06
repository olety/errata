// Read-only run over the local machine's real session logs, for the hour-12 checks.
// Reads ONLY <home>/.claude/projects/**/*.jsonl and <home>/.codex/sessions/**/rollout-*.jsonl.
// Writes only under --out, which must be outside this repository. Everything printed or written has passed
// through the parse-time redactor; the raw cross-check prints counts only.
//
//   bun scripts/real-run.ts --out <dir outside the repo> [--days 14] [--per-agent 12] [--wide]
// Every file is read in full (no tail window). The wall-clock of the read is measured and reported.

import { Glob } from 'bun';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseSessionFile } from '../src/parse/index';
import type { Session } from '../src/model';
import { allCalls, MAX_LINE_BYTES } from '../src/model';
import type { Episode } from '../src/episodes';
import { draftCards } from '../src/deck/templates';
import { lineWeight } from '../src/deck/file';
import { analyse } from '../src/pipeline';
import type { Room } from '../src/rooms';
import { isGenuineFailure } from '../src/noise';

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

const timing = { bytes: 0, ms: 0, files: 0, slowest: [] as { ms: number; mib: number; agent: string }[], perFile: new Map<string, { ms: number; bytes: number }>() };

async function timedParse(f: { abs: string; rel: string; size: number }): Promise<Session> {
  const t0 = performance.now();
  const s = await parseSessionFile({ rel: f.rel, blob: Bun.file(f.abs) });
  const ms = performance.now() - t0;
  timing.ms += ms;
  timing.bytes += f.size;
  timing.files++;
  timing.perFile.set(s.file, { ms, bytes: f.size });
  timing.slowest.push({ ms: Math.round(ms), mib: +(f.size / 1048576).toFixed(1), agent: s.agent });
  timing.slowest.sort((a, b) => b.ms - a.ms).splice(5);
  return s;
}

async function pick(files: { abs: string; rel: string; size: number }[], n: number): Promise<{ sessions: Session[]; skippedAgentAuthored: number; considered: number }> {
  const sessions: Session[] = [];
  let skipped = 0;
  let considered = 0;
  for (const f of files) {
    if (sessions.length >= n) break;
    considered++;
    const s = await timedParse(f);
    if (s.agentAuthored) {
      skipped++;
      continue;
    }
    sessions.push(s);
  }
  return { sessions, skippedAgentAuthored: skipped, considered };
}

const wall0 = performance.now();
const cc = await pick(ccFiles, PER);
const cx = await pick(cxFiles, PER);
const sessions = [...cc.sessions, ...cx.sessions];
const wallMs = performance.now() - wall0;

// ---- independent raw cross-check (counts only): call ids and result ids straight from the JSON rows
type Raw = { calls: Set<string>; results: Set<string>; paired: number; interrupts: number; userRows: number };
// One snapshot of the bytes feeds both the parser and the raw count, so a live session that grows between two
// reads cannot fake a mismatch.
async function rawCounts(s: Session, abs: string): Promise<{ raw: Raw; parsed: Session } | null> {
  if (s.partial) return null; // a cut last line is not comparable
  const bytes = await Bun.file(abs).bytes();
  const parsed = await parseSessionFile({ rel: s.file, blob: new Blob([bytes]) }, s.agent);
  const calls = new Set<string>();
  const results = new Set<string>();
  let interrupts = 0;
  let userRows = 0;
  const text = new TextDecoder().decode(bytes);
  for (const line of text.split('\n')) {
    if (!line) continue;
    // The same row bound as the parser: an oversized row is dropped and reported there, so it is skipped here too.
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
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
  return { raw: { calls, results, paired, interrupts, userRows }, parsed };
}

const absOf = new Map<string, string>();
for (const f of [...ccFiles, ...cxFiles]) absOf.set(f.rel.split('/').pop()!, f.abs);

const checks: string[] = [];
let pairingOk = true;
let interruptOk = true;
const perSession: string[] = [];
for (const s0 of sessions) {
  const snap = await rawCounts(s0, absOf.get(s0.file)!);
  const raw = snap?.raw ?? null;
  const s = snap?.parsed ?? s0;
  const calls = allCalls(s);
  // Compare by id: the parsed calls that correspond to raw call rows, and how many of them carry a result.
  const top = raw ? calls.filter((c) => raw.calls.has(c.callId)) : calls.filter((c) => c.parentCallId === null);
  const parsedPaired = raw ? top.filter((c) => c.result !== null && raw.results.has(c.callId)).length : top.filter((c) => c.result !== null).length;
  const interrupts = s.turns.filter((t) => t.role === 'interrupt').length;
  const roles = (['human', 'assistant', 'injected', 'interrupt'] as const).map((r) => `${{ human: 'h', assistant: 'a', injected: 'q', interrupt: 'x' }[r]}${s.turns.filter((t) => t.role === r).length}`).join(' ');
  if (raw) {
    if (raw.paired !== parsedPaired || raw.calls.size !== top.length) {
      pairingOk = false;
      if (args.includes('--debug-pairing')) {
        const parsedIds = calls.map((c) => c.callId);
        console.error(JSON.stringify({ file: s.file.slice(0, 12), agent: s.agent, parsedCalls: calls.length, inRaw: top.length, raw: raw.calls.size, parsedSample: parsedIds.slice(0, 3).map((x) => x.slice(0, 14)), rawSample: [...raw.calls].slice(0, 3).map((x) => String(x).slice(0, 14)), missing: [...raw.calls].filter((x) => !parsedIds.includes(x)).slice(0, 3).map((x) => String(x).slice(0, 14)) }));
      }
    }
    if (raw.interrupts !== interrupts) interruptOk = false;
  }
  perSession.push(
    `| ${s.agent} | ${s.client ?? '?'} | ${s.partial ? s.partialReason : 'full'} | ${roles} | ${top.length}/${raw?.calls.size ?? '–'} | ${parsedPaired}/${raw?.paired ?? '–'} | ${s.stats.orphanResults} | ${s.stats.oversizedRows} | ${interrupts}/${raw?.interrupts ?? '–'} | ${Object.values(s.stats.redactions).reduce((a, b) => a + b, 0)} |`,
  );
}
checks.push(`Pairing matches an independent raw count on every full session: ${pairingOk ? 'PASS' : 'FAIL'}`);
// Roles: no genuine human turn may start with a quarantined opener, and agent-authored sessions have none.
const OPENERS = /^\s*(<|This session is being continued|Another Claude session|\[Image|\[Request interrupted|# AGENTS\.md instructions)/;
const leaked = sessions.flatMap((x) => x.turns.filter((t) => t.role === 'human' && OPENERS.test(t.text)));
const agentHuman = sessions.filter((x) => x.agentAuthored && x.turns.some((t) => t.role === 'human')).length;
checks.push(`Roles: no human turn starts with injected text (${leaked.length} found) and no agent-authored thread has a human turn (${agentHuman} found): ${leaked.length === 0 && agentHuman === 0 ? 'PASS' : 'FAIL'}`);
checks.push(`Interrupt markers match an independent raw count on every full session: ${interruptOk ? 'PASS' : 'FAIL'}`);

const A = analyse(sessions);
const m = A.mirror;
const rooms = A.rooms;
const boundaryRooms = rooms.filter((r) => r.family === 'boundary' || r.family === 'directive');
const commandRooms = rooms.filter((r) => r.family === 'repeated-command');

// ---- wider search (script only): every top-level session in the window, read in full.
const WIDE = args.includes('--wide');
let wide: { analysis: ReturnType<typeof analyse>; skipped: number; considered: number; ms: number; bytes: number } | null = null;
if (WIDE) {
  const all: Session[] = [...sessions];
  let skipped = 0;
  let considered = 0;
  const w0 = performance.now();
  let bytes = 0;
  for (const f of [...ccFiles, ...cxFiles]) {
    const name = f.rel.split('/').pop()!;
    if (sessions.some((x) => x.file === name)) continue;
    considered++;
    if (name.startsWith('rollout-')) {
      const head = await Bun.file(f.abs).slice(0, 1 << 20).text();
      try {
        const src = JSON.parse(head.split('\n')[0] ?? '')?.payload?.source;
        if (src && typeof src === 'object' && 'subagent' in src) {
          skipped++;
          continue;
        }
      } catch {
        /* parse it */
      }
    }
    const x = await parseSessionFile({ rel: f.rel, blob: Bun.file(f.abs) });
    bytes += f.size;
    if (x.agentAuthored) {
      skipped++;
      continue;
    }
    all.push(x);
  }
  wide = { analysis: analyse(all), skipped, considered, ms: performance.now() - w0, bytes };
}

// ---- noise census: heads of genuine failures and of named negatives (redacted at parse time), for tuning the filter.
function census(ss: Session[]): { genuine: [string, number][]; negatives: [string, number][] } {
  const g = new Map<string, number>();
  const n = new Map<string, number>();
  for (const s of ss)
    for (const c of allCalls(s)) {
      if (!c.result) continue;
      const head = c.result.text.replace(/\s+/g, ' ').replace(/\/(?:Users|home)\/[^\s/]+/g, '~').replace(/[0-9a-f]{8,}/g, '#').slice(0, 70);
      if (isGenuineFailure(c)) g.set(head, (g.get(head) ?? 0) + 1);
      else if (c.result.negative) n.set(`${c.result.negative}: ${head}`, (n.get(`${c.result.negative}: ${head}`) ?? 0) + 1);
    }
  const top = (x: Map<string, number>) => [...x.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  return { genuine: top(g), negatives: top(n) };
}

function candidateBlock(md: string[], list: Room[], startAt: number): void {
  list.forEach((r, i) => {
    const e = r.anchor;
    const scope = r.projectLabel ? `global (seen in ${r.projectLabel})` : 'global';
    const cards = draftCards(r);
    md.push('');
    md.push(`### ${startAt + i}. ${r.name} — ${r.family}`);
    md.push('');
    md.push(`${r.subtitle}. Agents: ${r.agents.join(', ')}. Supporting sessions: ${r.sessions} (withheld for the boss: ${r.withheld.length}). Scope: ${scope}.`);
    md.push('');
    const pasted = e.type === 'interrupt' && e.pasted ? ' (pasted text, shortened)' : '';
    md.push(`- **Your words:** ${e.receipt.quote ? `“${e.receipt.quote}”${pasted}` : 'Tool evidence only'}`);
    md.push(`- **The action:** ${e.receipt.action ?? 'none recorded'}`);
    md.push(`- **The result:** ${e.receipt.result ?? 'none recorded'}`);
    if (e.receipt.then) md.push(`- **Then:** ${e.receipt.then}`);
    if (r.proposedConstraint) md.push(`- **Proposed line (editable):** ${r.proposedConstraint}`);
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
const mib = (b: number) => (b / 1048576).toFixed(1);
md.push(`# Real-log run (read-only, ${ts})`);
md.push('');
md.push('Aggregates and short redacted quotes only. Every file read in full; no tail window.');
md.push('');
md.push('## Import timing (Bun, this machine)');
md.push('');
md.push('| Measure | Value |');
md.push('|---|---|');
md.push(`| Files parsed while picking the run | ${timing.files} (${mib(timing.bytes)} MiB) |`);
md.push(`| Parse time, summed per file | ${(timing.ms / 1000).toFixed(1)} s (${(timing.bytes / 1048576 / (timing.ms / 1000)).toFixed(0)} MiB/s) |`);
md.push(`| Wall-clock for the run's import (picking included) | ${(wallMs / 1000).toFixed(1)} s |`);
const chosen = [...cc.sessions, ...cx.sessions].map((x) => timing.perFile.get(x.file)!).filter(Boolean);
const chosenMs = chosen.reduce((a, x) => a + x.ms, 0);
const chosenBytes = chosen.reduce((a, x) => a + x.bytes, 0);
md.push(`| The ${chosen.length} chosen sessions alone | ${mib(chosenBytes)} MiB parsed in ${(chosenMs / 1000).toFixed(1)} s |`);
md.push(`| Slowest files | ${timing.slowest.map((x) => `${x.agent} ${x.mib} MiB in ${x.ms} ms`).join('; ')} |`);
if (wide) md.push(`| Wider search, remaining files | ${wide.considered} files, ${mib(wide.bytes)} MiB in ${(wide.ms / 1000).toFixed(1)} s |`);
md.push('');
md.push('## Mirror (with denominators)');
md.push('');
md.push('| Measure | Value |');
md.push('|---|---|');
md.push(`| Sessions in the run | ${m.sessions.total} of the newest top-level sessions in ${DAYS} days (Claude Code ${m.sessions.claude} of ${ccFiles.length}, Codex ${m.sessions.codex} of ${cxFiles.length}) |`);
md.push(`| Agent-authored threads skipped while picking | Claude Code ${cc.skippedAgentAuthored} of ${cc.considered}, Codex ${cx.skippedAgentAuthored} of ${cx.considered} |`);
md.push(`| Partial sessions (cut last line) | ${m.sessions.partial} of ${m.sessions.total} |`);
md.push(`| Dates | ${m.dates.from} to ${m.dates.to} |`);
md.push(`| Projects | ${m.projects.total} (sessions with a project: ${m.projects.sessionsWithProject} of ${m.sessions.total}) |`);
md.push(`| Genuine human turns | ${m.humanTurns} |`);
md.push(`| Excluded system text | ${m.excluded.total} turns (${Object.entries(m.excluded.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}) |`);
md.push(`| Interventions (stop → your next message) | ${m.interventions.total} of ${m.interrupts} stops; ${m.interventions.lines} drew a line, ${m.interventions.pivots} read as a change of plan |`);
md.push(`| Repeated unchanged failing commands | ${m.repeatedCommand.episodes} in ${m.repeatedCommand.sessionsWith} of ${m.sessions.total} sessions (genuine failed shell runs ${m.repeatedCommand.genuineFailures} of ${m.repeatedCommand.shellCalls}) |`);
md.push(`| Not failures (named negatives) | ${Object.entries(m.negatives).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
md.push(`| Same-file edit sequences | ${m.editSequences.candidates} candidates in ${m.editSequences.sessionsWith} sessions; ${m.editSequences.promoted} promoted by a stop |`);
md.push(`| Repeated directives | ${m.directives.repeated} instructions across ${m.directives.sessions} sessions |`);
md.push(`| Verify workflow | ${m.workflows.occurrences} occurrences in ${m.workflows.sessions} sessions; verified rooms ${m.workflows.verified} |`);
md.push(`| Calls with a paired result | ${m.calls.withResult} of ${m.calls.total} (orphans ${m.calls.orphanResults}) |`);
md.push(`| Secrets redacted at parse time | ${m.redactions} |`);
md.push(`| Character card | ${m.character ? `${m.character.name}: ${m.character.line}` : 'not enough evidence'} |`);
md.push(`| Rooms | ${rooms.length}: ${[...rooms.map((r) => r.family + (r.kind === 'event' ? ' (event)' : '')).reduce((acc, f) => acc.set(f, (acc.get(f) ?? 0) + 1), new Map<string, number>()).entries()].map(([k, v]) => `${k} ${v}`).join(', ')} |`);
md.push(`| Route | ${A.route.nodes.map((n) => `${n.slot}:${n.kind}${n.rooms.length ? `(${n.rooms.length})` : ''}`).join(' · ')}; leftovers ${A.route.leftovers.length} |`);
md.push('');
md.push('## Candidates (the route\'s rooms, first five)');
const routed = A.route.nodes.flatMap((n) => n.rooms).filter((k, i, a) => a.indexOf(k) === i).map((k) => rooms.find((r) => r.key === k)!).filter((r) => r.kind !== 'event');
candidateBlock(md, routed.slice(0, 5), 1);
if (wide) {
  const wm = wide.analysis.mirror;
  md.push('');
  md.push(`## Wider search: every top-level session in ${DAYS} days, read in full`);
  md.push('');
  md.push(`Sessions ${wm.sessions.total} (Claude Code ${wm.sessions.claude}, Codex ${wm.sessions.codex}; agent-authored skipped ${wide.skipped} of ${wide.considered} considered). Interventions ${wm.interventions.total} of ${wm.interrupts} stops (${wm.interventions.lines} lines, ${wm.interventions.pivots} plan changes). Repeated failing commands ${wm.repeatedCommand.episodes} in ${wm.repeatedCommand.sessionsWith} sessions. Edit sequences ${wm.editSequences.candidates} (${wm.editSequences.promoted} promoted). Repeated directives ${wm.directives.repeated}. Verify workflow ${wm.workflows.occurrences} in ${wm.workflows.sessions} sessions. Negatives ${Object.entries(wm.negatives).map(([k, v]) => `${k} ${v}`).join(', ')}. Rooms ${wide.analysis.rooms.length}. Character ${wm.character ? `${wm.character.name}: ${wm.character.line}` : 'none'}.`);
}
const cen = census(wide ? wide.analysis.sessions : sessions);
md.push('');
md.push('## Noise census (heads of results, home paths and hex runs masked)');
md.push('');
md.push('Genuine failures, most frequent first:');
for (const [h, n] of cen.genuine) md.push(`- ${n} × ${h.replace(/\|/g, '/')}`);
md.push('');
md.push('Named negatives:');
for (const [h, n] of cen.negatives) md.push(`- ${n} × ${h.replace(/\|/g, '/')}`);
md.push('');
md.push('## Hour-12 checks on this run');
md.push('');
for (const c of checks) md.push(`- ${c}`);
md.push('');
md.push('## Per-session pairing (parsed / raw)');
md.push('');
md.push('| Agent | Client | Read | Turns (h human, a assistant, q quarantined, x interrupt) | Calls | Paired | Orphans | Oversized rows | Interrupts | Redactions |');
md.push('|---|---|---|---|---|---|---|---|---|---|');
md.push(...perSession);

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'real-run.md'), md.join('\n') + '\n');
await writeFile(join(OUT, 'real-files.txt'), [...cc.sessions, ...cx.sessions].map((x) => absOf.get(x.file)!).join('\n') + '\n');
console.log(checks.join('\n'));
const chosenT = [...cc.sessions, ...cx.sessions].map((x) => timing.perFile.get(x.file)!).filter(Boolean);
console.log(JSON.stringify({ import: { files: timing.files, mib: +mib(timing.bytes), parseSec: +(timing.ms / 1000).toFixed(2), wallSec: +(wallMs / 1000).toFixed(2), chosen: { files: chosenT.length, mib: +mib(chosenT.reduce((a, x) => a + x.bytes, 0)), sec: +(chosenT.reduce((a, x) => a + x.ms, 0) / 1000).toFixed(2) } }, wide: wide ? { files: wide.considered, mib: +mib(wide.bytes), sec: +(wide.ms / 1000).toFixed(2), sessions: wide.analysis.mirror.sessions.total } : null, sessions: m.sessions, interventions: m.interventions, repeated: m.repeatedCommand.episodes, negatives: m.negatives, edits: m.editSequences, directives: m.directives, workflows: m.workflows, rooms: rooms.length, route: A.route.nodes.map((n) => n.kind), character: m.character?.name ?? null }));
