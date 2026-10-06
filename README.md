# Errata

Errata turns your Claude Code and Codex sessions into a card game. Your deck is your global CLAUDE.md and AGENTS.md. Each room is a moment from your own sessions where the agent went wrong: you stopped it, it retried a failing command, or it rewrote the same file again. You judge each case, then play a card that becomes one line in your files. At the campfire you merge duplicate lines, cut weak ones and settle lines that disagree. Nothing leaves the browser tab. Nothing is written until Apply. Apply shows the exact diff, keeps byte-exact backups, reads every file back, and offers Undo.

Built for Hackyard Yard #4, 2026-10-05 → 10-09. MIT licence, see `LICENSE`. Live page: https://olety.github.io/errata/

## Privacy

- Errata reads only these files, and only the ones you choose:
  - `~/.claude/projects/**/*.jsonl` (Claude Code sessions)
  - `~/.codex/sessions/**/rollout-*.jsonl` (Codex sessions)
  - `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (the two global files)
  - the skill folders `~/.claude/skills` and `~/.agents/skills`, when you play a Skill card
- It never reads `auth.json` or anything else in those folders.
- Secrets are redacted as each line is parsed. Redacted text never reaches a card.
- Everything runs in your browser tab. There is no back end and no upload. The page makes no network request to any other site, before or after it loads: its fonts, art and sample are served from the same address as the page.
- Write access is asked for only at Apply.
- The synthetic sample is built from licensed public rows. Its sources and licences are listed in `public/sample/manifest.json`.

## Run it yourself

```sh
bun install
bun run dev     # open the address Vite prints
bun test        # the engine, adapter, sample and safety tests
bun run build   # a static build in dist/
```

Choose **Play the synthetic sample** to try it without your own logs. To run it on your own logs, follow the one-page checklist in [docs/REAL-RUN-CHECKLIST.md](docs/REAL-RUN-CHECKLIST.md). Reading your own folders needs a Chromium browser (see Known limits).

## How it works

- **The atom.** One episode is one moment in one session where you stopped the agent and said what to do instead, the same command failed again unchanged, or the same file was edited three or more times; each head on a beast is one such case, and a verified check, diff and report workflow is a success, never a problem.
- **The cover rule.** A line answers a case only when all eight checks hold: you stamped the case a problem, the line is in the proposed file that agent reads, it targets that agent, its scope matches the case's project, its trigger fits the case, its response fits what the case shows, no exception on the line excludes it, and you accepted the line for that case.
- **What is written where.** Claude Code lines go to `~/.claude/CLAUDE.md`, Codex lines to `~/.codex/AGENTS.md`. The game's lines live in one managed block between `<!-- deck:begin v1 -->` and `<!-- deck:end -->`, one bullet per line, each ending with a `<!-- deck:<id> -->` marker that carries the line's stable id. Everything outside the block stays byte for byte, unless you edit or cut one of your own lines at the campfire. A Skill card writes `~/.claude/skills/<name>/SKILL.md`, and `~/.agents/skills/<name>/SKILL.md` when you grant `~/.agents`. A non-empty `~/.codex/AGENTS.override.md` blocks the Codex lane, because Codex then ignores `AGENTS.md`. The game never writes the override.
- **The backups folder.** Before any write, Apply makes a new folder `~/.claude/.deck-backups/<bundle id>/` with a copy of each file before and after, plus a manifest with their checksums. Every copy is read back before the first write. Every written file is read back after it.
- **Undo.** Undo restores a file to its original bytes only when the file still equals what Apply wrote. A file changed since then is left alone and reported. If you choose "Keep the receipt" after Apply, this browser keeps the receipt, the stable line ids and the folder grants, and the import page offers Undo on your next visit.

## Synthetic sample

**Play the synthetic sample** runs twelve made-up sessions (eight Claude Code, four Codex) in two projects, with a small `CLAUDE.md` and `AGENTS.md`. The sessions were written for the game around two rows of public agent trajectories. Only some tool calls and results come from the rows. The human turns, the corrections, the other tool calls and the session metadata are authored. The sample's Apply writes to this browser's private storage, never to your files.

`public/sample/manifest.json` records both datasets that were considered, with their revisions and licences, every row used with its checksum, and which events were sourced and which were authored:

| Dataset | Licence | Used |
|---|---|---|
| `nvidia/SWE-Hero-openhands-trajectories` (revision `150bc11`) | CC-BY-4.0 | 2 rows, from the MIT-licensed repositories Pylons/pyramid and datalad/datalad |
| `SWE-bench/SWE-smith-trajectories` (revision `08e109b`, `tool` split) | MIT | inspected, no row used |

Attribution: the sample's sourced tool content is adapted from "NVIDIA SWE-Hero OpenHands trajectories" by NVIDIA (https://huggingface.co/datasets/nvidia/SWE-Hero-openhands-trajectories), licensed CC-BY-4.0. Changes were made: selected tool calls and results were reordered, trimmed and converted to the Claude Code and Codex log formats inside authored sessions. Each row's code comes from its repository under the MIT licence.

## Known limits

- Reading and writing folders needs the File System Access API, which only Chromium browsers have (Chrome, Edge, Brave, Arc).
- In Firefox and Safari you can drop session files instead. Apply then gives you each file's block to paste or download ("Exported, not applied").
- Codex support covers the rollouts that the Codex CLI, the IDE extension and the desktop app write under `~/.codex/sessions`. Codex in the ChatGPT app (cloud tasks) is not claimed.
- Token figures are estimates: UTF-8 bytes divided by three, rounded up per block. They are not a tokenizer count. Each file's token budget is 1,200 by default, or its own size if it arrives larger.
- The game does not test whether an agent follows the lines it writes.

## Licence

MIT. See `LICENSE`. The fonts are four SIL Open Font License 1.1 families, self-hosted in `public/fonts/` with their licences; `public/fonts/SOURCES.md` records where each file came from.
