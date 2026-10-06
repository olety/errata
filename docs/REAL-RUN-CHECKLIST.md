# Real-run checklist: your own logs, in your own browser

The folder picker needs a person's click, so no headless test can drive it. This page is the run to do by hand once, in a Chromium browser (Chrome, Edge, Brave or Arc), on https://olety.github.io/errata/ or on `bun run dev`. It takes about ten minutes. Firefox and Safari cannot open folders: there you can only drop files, and Apply exports the blocks to paste.

Optional first: copy `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` somewhere safe. The game keeps its own backups; this copy is yours.

## Do this, and expect this

| # | Do | Expect |
|---|---|---|
| 1 | Open the site. | The lake, two closed books (CLAUDE.md "not read yet", AGENTS.md "read at the mirror or at Apply"), three paper slips. |
| 2 | Click **Choose your ~/.claude folder**. In the macOS picker press Cmd+Shift+. to show hidden folders, pick `~/.claude`, then **View files**. | Chrome asks to let the site view files (read only). The CLAUDE.md book shows "file weight N of 1,200 tok" and "room left …". A **This run** slip counts your Claude Code sessions from the last 14 days, up to 12. |
| 3 | Click **Choose ~/.codex/sessions** and pick `~/.codex/sessions`. | The slip adds your Codex sessions. Subagent threads are left out and counted. |
| 4 | Click **Start the run**. | The reading page: one file at a time with bytes read, then the mirror. Cancel would keep what was read. |
| 5 | On the mirror, click **Choose ~/.codex** (optional, read only). | AGENTS.md is read. If `~/.codex/AGENTS.override.md` is not empty, the AGENTS.md book says "Your Codex reads AGENTS.override.md; edits to AGENTS.md would be ignored. The Codex lane is blocked." |
| 6 | Click **Start the act** and play: stamp each head, deal, click a card and then the beast, merge and settle at the fires. | Both books keep the **Proposed** stamp. Nothing on disk changes while you play. |
| 7 | Reach **Apply** without granting write access. | "Choose the folders that hold your two files to see the diff." The seal is shut. |
| 8 | Click **Choose your ~/.claude folder** and **Choose your ~/.codex folder** (and the `~/.agents` one only if a Skill card is in play). | Both diffs. Only lines inside `<!-- deck:begin v1 -->` … `<!-- deck:end -->` are added or removed, unless you edited or cut one of your own lines at a fire. With an active override, AGENTS.md carries the blocked notice and is not written; CLAUDE.md still is. |
| 9 | Click the seal. When Chrome asks to let the site edit files, allow it. | Reviewed, Fits and Written ink one by one. A backup id shows: `.deck-backups/<id>`. |
| 10 | In a terminal: `ls ~/.claude/.deck-backups/` then `cat ~/.claude/.deck-backups/<id>/manifest.json` and `diff ~/.claude/.deck-backups/<id>/before/claude/CLAUDE.md ~/.claude/CLAUDE.md`. | The manifest lists each file with its before and after checksums. The diff shows only the managed block. |
| 11 | Back in the game, click **Undo · crack the seal**. | Each file reads "restored to the original bytes". `shasum -a 256 ~/.claude/CLAUDE.md` matches the manifest's before checksum. |
| 12 | Optional: play again to a Written seal, click **Keep the receipt**, reload the page. | The import page shows "Your last Apply, kept in this browser" with **Undo it** and **Forget it**. Undo it asks for write access to the same folders and restores them. |

## What must never happen

- A file written outside `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.claude/skills/<name>/`, `~/.agents/skills/<name>/` and `~/.claude/.deck-backups/`.
- `~/.codex/auth.json`, `config.toml`, history or any file other than `projects/**/*.jsonl` and `sessions/**/rollout-*.jsonl` being opened. (DevTools, Sources, the page's own code: the folder walk accepts only those names.)
- `AGENTS.override.md` created or changed.
- Any write before the seal. Any write after a refusal of edit access.
- A network request carrying session text. In DevTools, Network: only the page, its own assets and Google Fonts.
- Undo overwriting a file you changed after Apply. It must say "changed after Apply; nothing was overwritten".
- A secret from a session (a key, a token) showing on a card, a slip or a receipt.

If any of these happens, stop, keep the backup folder, and note the step number.
