# The demo film

`errata-demo-16x9.mp4`: 34.8 s, 1920 × 1080, H.264 High yuv420p, 30 fps, AAC 48 kHz stereo, −16 LUFS. It follows [SCRIPT.md](SCRIPT.md) beat by beat on the built site and the synthetic sample. This page says how it was made.

Re-captured on 2026-10-10 after the text-density pass, so the film matches the live site. The narration, the caption slips and the title and end cards are the 10-07 ones; the gameplay was recorded again on the same route with the new UI and cut the same way. On screen now: the stamps are ink marks with their word under them; the books show "budget" and "104 / 1,200 tok"; the card footer is an eye "3 sessions" and a target "3 cases"; the coach lines are eight words at most; the campfire threads carry a knot, and the merge preview shows "−19 tok" and "3 → 3 cases"; the buttons read Seal, Leave and Undo; the boss tally reads "Later cases 2 / 2". Beat 2 runs about 0.75 s longer: after the third stamp the pointer rests on the CLAUDE.md book's (i) and its tooltip opens ("~/.claude/CLAUDE.md · 104 of 1,200 used · 1,096 left"), the only tooltip in the film. Between actions the pointer rests in an empty corner, so no other tooltip opens by hover. Re-captured again on 10-10 01:50 after the receipt moved to the centre.

## Capture

- The built site (`bun run build`, `dist/` served on localhost), Chrome 154 headless driven by playwright-core 1.55. Viewport 1920 × 1080, zoom 100 %, the page's own self-hosted fonts. The run used only **Play the synthetic sample**; no folder picker appears. The recorder refused every request to any other host (the page made none).
- The input is what SCRIPT.md names: the keys A, C and Enter, clicks, and the two drags (room 1's card onto the wyrm, the same card onto the boss head) as real pointer events through the Chrome DevTools Protocol: pointerdown on the card, pointermove past the 6 px threshold and on to the target, pointerup on it. The steps under each CUT ran off camera.
- The frames were recorded on a held animation clock. The Mac was loaded by other jobs (load average 30 to 55), and a real-time screencast gave less than one frame a second. On camera the recorder pauses every animation on the page (CSS animations and transitions, `element.animate`) and sets its `currentTime` from its own clock, one screenshot per 1/30 s. An animation that reaches its end is finished with `finish()`, so anything the page chains on it runs as it would in real time. The game's code is unchanged; only the clock its animations read is held. Waiting for the sample to load takes no film time.
- The cut plays every piece at the page's own speed, except the two drags, which run at a set pace (1.0 s and 1.9 s). Beats meet on hard cuts; inside a beat the cuts drop the still waits between actions and the steps listed below.

## What the film leaves out of SCRIPT.md

- Beat 4: the force-push merge shows only from its preview ("−6 tok") to the seal; the thread and card clicks before it are cut.
- Beat 5: the second boss head (Codex · pyramid · 2026-10-05) was played on the take but is cut; the film goes from the first answered head to the score sheet, "Later cases 2 / 2".
- The sample's loading message before the mirror.

## Voice

ElevenLabs text to speech, the voice George (`JBFqnCBsd6RMkjVDRZzb`, as in the Yard #3 film), model `eleven_multilingual_v2`, speed 1.1, stability 0.62, similarity 0.8, style 0. One request for the whole narration, with character timestamps; each sentence was cut from that take and placed on its beat. 27.0 s of speech:

> This deck is the rules file my coding agents read. Every monster is a pattern from my own history. One card answers all three cases, and inks into both books. At the campfire, duplicates merge, and the budget drains. The boss replays the cases I held back: two of two. Apply shows the diff, keeps a backup, and reads every file back. Undo restores the original bytes. Review the history. Improve the rules. Nothing uploaded.

The opening and closing lines are the draft's. The lines between are SCRIPT.md's draft lines, shortened to fit. None of them says a line prevents anything, and token figures are called a budget.

## Captions

One line at a time: the narration's own sentences, timed by the ElevenLabs character alignment, in Zen Kaku Gothic New 500 from `public/fonts`, ink `#41291F` on a paper slip `#FFF9EE` with the coach slip's border and shadow. The slip sits on the bottom paper strip, below every card and book. While a sentence is spoken it covers the game's own coach line there.

## Render

Plain ffmpeg 8.1.1:

- the frames concatenated with their film durations into the gameplay track;
- a title card (Errata, Shippori Mincho B1 800) and an end card (the closing line in Shippori Mincho B1 600; `github.com/olety/errata` and `olety.github.io/errata` in JetBrains Mono), paper slips over the dusk world plate the table art was made from;
- a 0.2 s crossfade in and a 0.25 s crossfade out, hard cuts between beats, no other transitions;
- the caption slips overlaid with 0.1 s fades;
- the narration mastered with two-pass loudnorm to −16 LUFS integrated, true peak −1.5 dBTP;
- libx264 High, yuv420p BT.709 limited range, AAC 192 kb/s, `+faststart`.

The cards and slips were drawn with Pillow from the same font files. A square 1080 × 1080 cut and the stills were made alongside and are not in the repo. The recorder and edit scripts stay with the working files.

## Tools and licences

- Google Chrome; playwright-core (Apache-2.0); ffmpeg with libx264 (GPL build); Pillow (MIT-CMU licence); Python.
- Fonts: Shippori Mincho B1, Zen Kaku Gothic New and JetBrains Mono, SIL Open Font License 1.1, the files in `public/fonts` (sources in `public/fonts/SOURCES.md`).
- Voice: generated with ElevenLabs on the author's account; ElevenLabs' terms apply to the audio.
- Art: the game's own, and the world plate it was made from.
- On screen: the synthetic sample. Its sourced tool content is adapted from "NVIDIA SWE-Hero OpenHands trajectories" by NVIDIA (https://huggingface.co/datasets/nvidia/SWE-Hero-openhands-trajectories), licensed CC-BY-4.0, with changes; each row's code comes from its repository (Pylons/pyramid, datalad/datalad) under the MIT licence. See the README's Synthetic sample section and `public/sample/manifest.json`.
