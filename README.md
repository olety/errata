# Errata

Errata turns your Claude Code and Codex sessions into a card game. Your deck is your global CLAUDE.md and AGENTS.md. Each room is a moment from your own sessions where the agent went wrong: you stopped it, it retried a failing command, or it rewrote the same file again. You judge each case, then play a card that becomes one line in your files. At the campfire you merge duplicate lines, cut weak ones and settle lines that disagree. Nothing leaves the browser tab. Nothing is written until Apply. Apply shows the exact diff, keeps byte-exact backups, reads every file back, and offers Undo.

**Status:** being built for Hackyard Yard #4 during the week of 2026-10-05. Expect rough edges.

## Privacy

- Errata reads only these files, and only the ones you choose:
  - `~/.claude/projects/**/*.jsonl` (Claude Code sessions)
  - `~/.codex/sessions/**/rollout-*.jsonl` (Codex sessions)
  - `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (the two global files)
  - the skill folders `~/.claude/skills` and `~/.agents/skills`, when you play a Skill card
- It never reads `auth.json` or anything else in those folders.
- Secrets are redacted as each line is parsed. Redacted text never reaches a card.
- Everything runs in your browser tab. There is no server and no upload.
- Write access is asked for only at Apply.
- The synthetic sample is built from licensed public rows. Its sources and licences are listed in `public/sample/manifest.json`.

## How to run

```sh
bun install
bun run dev
```

Open the address Vite prints. Choose **Play the synthetic sample** to try it without your own logs.

```sh
bun test        # the engine and sample tests
bun run build   # a static build in dist/
```

Reading your own folders needs a browser with folder access (Chrome or Edge). Other browsers can drop session files and get the result as text to paste.

## Licence

MIT. See `LICENSE`.
