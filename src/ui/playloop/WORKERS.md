# Play loop P1: the four worker handouts (written 2026-10-07 by the P0 integrator)

Four workers build in parallel against a frozen contract. This file is what the lead turns into four briefs.

## Read first, every worker

- `src/ui/playloop/contract.ts`: the types and copy selectors you code against. Frozen.
- `src/ui/playloop/CONTRACT.md`: who consumes what, which act finalizes a room, the worker rules.
- `design/play-loop-v2.md` in the lead's Yard #4 folder: the loop. Section 0a binds over the rest. The lead's brief gives the full path.
- Your own stubs: they compile and render a plain placeholder. Replace the bodies; keep the export names and props.

## How to see your work

```sh
bun install
bun run dev
```

- `http://localhost:5173/errata/#play-ui` runs the sample through the workers' screens (the mount in `mount.ts`).
- `http://localhost:5173/errata/#play` runs the plain debug render: every view field as text, every act as a button.
- Both load the synthetic sample automatically. The slice at `/errata/` stays the default route until P1 lands.

## Rules for every worker

1. Edit only your folders. Only the integrator edits `contract.ts`, `adapter.ts`, `controller.ts`, `drag.ts`, `geometry.ts`, `mount.ts`, `debug.ts`, `src/ui/main.ts`, `src/ui/style.css`, `index.html`, `package.json` and the lockfile.
2. Import from `../contract`, and from `../cards` (the base layer's exports). Never import the adapter, the engine, or another worker's internals.
3. Never compute a number. Every number comes in a view. Print `estimated` beside every token figure.
4. Take copy from `COPY` and the selectors in the contract. Never write prevented, killed, defeated, damage, saved time, worked or fired.
5. Animate only what a result says happened. The bind cascade plays `PlayResultView.bound` in that order; the strike plays `standing`. Never bind optimistically and correct later.
6. Register every drop target through the `DropBinder` you receive, at least 44 by 44 px and 8 px apart. The mount clears registrations before each paint, so bind as you render. Open is never a drop target.
7. Strings from logs are text, never HTML. Inline code arrives as backtick spans; render them as `<code>` elements built with `textContent`.
8. Styles: one CSS file in your folder, imported by your own module, every class prefixed `pl-<folder>-`. Never edit the shared stylesheet.
9. No forced waits. Every animation is interruptible: the next input moves on. Under `ui.reducedMotion`, use static states.
10. `bun test` stays green at every commit. Pure helpers get tests in `tests/playloop-<folder>.test.ts`. No new runtime network calls, no package changes. Fixtures and the sample only; never real traces.
11. Need a field the contract lacks? Ask the integrator. Do not work around it.
12. Arms: Sol for bulk tests, Astra for geometry and review, as `design/builder-arms.md` in the lead's folder says. No computer-use, screen or browser tools in arms.

---

## 1. cards/layout (the base layer: land the Card first)

**You own:** `src/ui/playloop/cards/*`, `src/ui/playloop/layout/*`.

**You consume:** `CardView`, `CardFaceView`, `CardInspectorView`, `BookView`, `PilesView`, `OpenPageView`, `GhostDelta`, `DragPreview` (its `ghost` and `line`), `RouteView`, `RouteKnotView`, `StatusView`, `Bands`, `UiView`, `DropBinder`, `ControllerApi` (`inspect`, `select`, and the inspector's `campfire.acceptMapping`, `acceptImport`, `sharpen`, `retarget`, `raiseAllowance`).

**You export (names and props frozen):**

| Export | From | Props |
|---|---|---|
| `Card` | `cards/index.ts` | `CardProps { card, size: 'S' \| 'M' \| 'L', selected, drag: DropBinder \| null, onInspect }` |
| `Hand` | `cards/index.ts` | `HandProps { cards, bands, ui, api, drag }` |
| `Books` | `cards/index.ts` | `BooksProps { books, preview, mode: 'play' \| 'retarget', layout: 'props' \| 'tabs', drag }` |
| `Piles` | `cards/index.ts` | `PilesProps { piles, layout: 'props' \| 'rail', shelfTarget, api, drag }` |
| `Inspector` | `cards/index.ts` | `InspectorProps { card, receipt, layout: 'side' \| 'sheet' \| 'stage', api }` |
| `Table` | `layout/index.ts` | `TableProps { bands, header, stage, wood, status }` |
| `RouteHeader` | `layout/index.ts` | `{ route, title, subtitle }` |
| `StatusBar` | `layout/index.ts` | `{ status, notice }` |

**Acceptance checks:**

- One fixed card box at S 148×207, M 176×246, L 208×291 with the five zones of §10. Type sizes per §0a.20. The art panel is fixed with a centred 4:3 image, 138 px wide at M.
- The face shows `face.title`, `face.summary` and, for an excerpt, `face.mark`. No verbs and no buttons on the face. Validate faces by rendered pixels at M: a test renders every sample draft and fails on overflow.
- Footer at M on two lines: provenance, then `footer.text` in rooms only.
- Long-press, right-click, F and an external 44 px Inspect control open the inspector. The dog-ear is decoration only.
- Books: the **Proposed** watermark while `proposed`; the strap shows `weight.now` of `weight.allowance` with `estimated`; the clasp opens when `over`; the ghost segment and its `text` come from `preview.ghost[lane]`; the exact `preview.line.text` typesets on the open page at reading size before release.
- Hand: `bands.fan` decides rotated, flat or carousel. On phones a horizontal swipe scrolls and never plays a card.
- Piles: the shelf is a target only when `shelfTarget`; Open is a list, never a target.
- Table: bands at the exact heights in `Bands` for 1440×900, 1024×768 and 390×844, with nothing overlapping and nothing below 44 px. Phones get two book tabs and one pile rail.
- Inspector: render `ui.inspector`. For a card: the reading (exact line in mono, scope, exceptions, files), chips for targets and trigger, `weightMath`, the evidence with each session's receipt, one row per `mappings` entry with an Accept control when `eligible && !accepted` (`api.campfire.acceptMapping`), a Skill's first lines and estimate labelled outside the allowance, and `unavailable` reasons. For a case: the receipt and its room's queue. Withheld cases never arrive here before the boss.
- Draft comparison: selecting one draft and then another shows the two cards' `playPreview`s side by side (files, glowing heads, per-lane ghosts). Both are computed on the same proposal.
- Counts come from the view (`shelfCount`, `openCount`, `receipts.progress`); never `.length` on game data.

**Integration points the integrator wires:** `mount.ts` already calls `Books`, `Hand`, `Piles` in the room's wood, `Table`, `RouteHeader` and `StatusBar` for every screen, and `Inspector` as an overlay. Campfire and end import `Card`, `Books` and `Piles` from `../cards`.

---

## 2. room/rig

**You own:** `src/ui/playloop/room/*`, `public/playloop/beasts/*`. The art is in `plates/rig/` in the lead's Yard #4 folder: `body-*.png`, `head-*.png` for wyrm, hydra, stag and moth, `owl-workshop.png`, and `meta.json`. Copy what you use into `public/playloop/beasts/<skin>/`. There is no heron plate yet; ask the lead.

**You consume:** `RoomView`, `BeastView`, `HeadView`, `HeadState`, `OverflowView`, `PipsView`, `ReceiptView`, `HeadGlow` (from `ui.drag.preview.heads`), `PlayResultView` (from `view.result`), `UiView` (`beat`, `reducedMotion`, `bands`), `STAMPS`, `Skin`, `ControllerApi` (`stamp`, `focusReceipt`, `deal`, `pullBack`, `advance`, `answerExisting`, `wording`).

**You export (names and props frozen):**

| Export | From | Props |
|---|---|---|
| `RoomScreen` | `room/room-screen.ts` | `ScreenProps<RoomView>`, returns the stage band |
| `EventScreen` | `room/room-screen.ts` | `ScreenProps<RoomView>`, returns the stage band |
| `Beast` | `room/beast.ts` | `BeastProps { beast, glow, beat, reducedMotion, height, drag, onHead }` |
| `ReceiptStage` | `room/stage.ts` | `{ room, api }` |
| `RIGS` | `room/rig.ts` | `Record<Skin, Rig>` with sockets and anchors measured from the plates |
| `RibbonLayer` | `room/ribbon.ts` (new) | returns `{ el: SVGSVGElement; draw(from, to \| null): void }`, the same shape as `ribbonLayer` in `mount.ts` |

**Acceptance checks:**

- One rig logic for every skin (§0a.22): body plate, one head sprite per skin at a fixed scale, five sockets, SVG necks masked behind the body, one shared ground shadow. The feet stand on `bands.shoreY`.
- Head states from `HeadView.state` only. A head folds below its socket only when its state is `bound`. Standing heads strike once when `ui.beat` is `strike`; the page tears toward the Open pile.
- The boat only when `pips.fully`. All-set-aside and all-wrapped rooms never get it. Print `pips.text`; never "0/0".
- Overflow prints `overflow.text` exactly.
- Head tags: agent sigil, project chip, date, each with its own 44 px hit region. Rings show `rings.count` and say what they count.
- One complete receipt at a time from `receipts.current`, with the queue visible and immediate advance. The four stamps from `STAMPS`. Keys A, C, N and U are the controller's; do not bind them again.
- While dragging, glowing heads lean in and the others turn aside with `HeadGlow.word`. Nothing binds until `view.result` says so.
- Controls: Deal when `canDeal`; Pull the hand back while dealt; Continue or Keep existing from `offer`; the `finalizes` line while dealt; the "Already in your file?" prompt from `existingAsks`, showing its full `reading` before Yes.
- The review lock: show `review.remaining` ("2 heads still to stamp"); Deal and Continue wait for `review.canFinalize`.
- `heads[0]` is the anchor: it leans in first. `wording` is the editable line for boundary and directive rooms (`api.wording`).
- Binds after the room's play (an existing line accepted, a card dragged from a book onto a standing head) arrive as `ui.effect.bound`; fold those heads too, once per effect id.
- The Workshop: lanterns, one per verified session; the bench is the beast target and the verb is `forge`.
- The Event (§8): a heron with its slip. A change of plan flies off; A problem turns it into a one-head room.
- Reduced motion: static icons, no ribbons, no folds; counts still change.

**Integration points the integrator wires:** `mount.ts` puts `RoomScreen` or `EventScreen` in the Table's stage band and swaps `ribbonLayer` for your `RibbonLayer`.

---

## 3. campfire

**You own:** `src/ui/playloop/campfire/*`.

**You consume:** `CampfireView`, `ThreadView`, `ChangePreviewView`, `LaneTab`, `SettleChoice`, `UiView.pending`, `CardView`, `BookView`, `PilesView`, `DragPreview` (verbs `fuse`, `settle`, `cut`, `swap`, `widen`, `narrow`), `ControllerApi.campfire.*`, `cancel`, `advance`.

**You export (names and props frozen):**

| Export | From | Props |
|---|---|---|
| `CampfireScreen` | `campfire/campfire-screen.ts` | `ScreenProps<CampfireView>`, returns `{ stage, wood }` |
| `SealPreview` | `campfire/campfire-screen.ts` | `{ preview: ChangePreviewView \| null }` |

**Acceptance checks:**

- Lane tabs (Claude, both, Codex) and one focused pair (§0a.21); the creature band holds the pair and its preview.
- Gold threads print `reason`; red threads print `reason`. Never "these say the same thing" without the reason.
- Stacking proposes, sealing performs. A card dropped on a card sets `ui.pending` to a stack of the whole thread (`members`; the uv triple seals as one); read the preview with `api.campfire.changePreview({ threadId })`; seal on a 0.6 s hold or Enter with `fuse` or `settle`. Pulling the top card off or Escape calls `cancel`. Swap, re-target, cut and sharpen preview the same way (`{ swap }`, `{ retarget }`, `{ cutId }`, `{ sharpen }`) and seal with their own api call; a preview with `refused` cannot seal.
- After a fuse or sharpen, `resultId` is the card left in the deck; offer `needsAcceptance` cases with `acceptMapping(resultId, caseId)`.
- A gold thread without `autoText` opens an editor holding both lines; the player writes the merged line.
- A red pair offers four slots: keep one, separate the conditions (from `projects`), write an exception, cancel. Show the resulting exported `lines` before the seal. Cancel leaves the thread.
- Every preview prints `cases.text` ("Affected cases: 0 · deck total: 3 → 3") and both ghosts with `estimated`. `needsAcceptance` lists cases a new text must be accepted for, each with an accept control.
- The fire: a drop sets a pending cut; the preview shows the deletion, the weight freed and the reopened cases; the seal burns it. The ash list restores until Apply.
- The books re-target (`book-retarget`) to `pending.targets`; seal with `campfire.retarget(cardId, targets)`. The shelf swap is a reviewed panel. The pinned Open receipt shows `pinnedCandidates` (eligibility, never coverage) and is never a target.
- The coach line when a clasp is open. Leaving is free.

**Integration points the integrator wires:** `mount.ts` places your `stage` and `wood` in the Table and resolves drops to `ui.pending` through the controller.

---

## 4. boss/apply (presentation only)

**You own:** `src/ui/playloop/end/*`.

**You consume:** `BossView`, `BossHeadView`, `BossCandidateView`, `ApplyView`, `ApplyDiffView`, `ApplyBlockerView`, `InkState`, `ReceiptView`, `CardView`, `BookView`, `STAMPS`, `ControllerApi.boss.*`, `apply.*`, `advance`.

**You export (names and props frozen):**

| Export | From | Props |
|---|---|---|
| `BossScreen` | `end/boss-screen.ts` | `ScreenProps<BossView>`, returns `{ stage, wood }` |
| `ApplyScreen` | `end/apply-screen.ts` | `ScreenProps<ApplyView>`, returns `{ stage, wood }` |

**Acceptance checks:**

- Sealed heads rise one at a time, oldest first. `heads` holds only revealed heads; `remaining` is the count still hidden (never their words). `turn` drives the screen: `stamp` (receipt readable, no candidates), `answer`, `set-aside`, `summary`. The blind stamp locks on click.
- Once stamped a problem, only cards whose candidate `glow` is true glow in their books; drag one onto the head (bind the head with `drag.bindTarget`, the cards with `drag.bindCard`). "No eligible card" prints each candidate's `reason`. Continue is always there.
- The earlier Open pages (`source: 'open'`) rise after the sealed heads and face the final deck the same way.
- The score prints `score.lines` exactly, set-asides always beside it. `score.validity` is `live`, `locked` or `stale`; a stale score is never shown as final.
- Apply: both diffs with context, Skill bodies first. Blockers with "Return to the final campfire" (`apply.returnToCampfire(blocker.select)`). Folder grants through `apply.grant`. Disable every control while `busy` is not `idle`. The seal only when `canSeal`. Reviewed, Fits and Written ink one by one, each only when its `InkState` is `inked`; `result.files` says which files verified. Undo when `canUndo`. The footer only when `footer` is not null (a verified write).
- The end screen from `summary`: the score lines, the Open pages, every set-aside by date, the shelf as "not written", the operation counts, both files' weights with any allowance raise "by you".
- No write logic of your own: the engine's protocol runs behind `api.apply`.

**Integration points the integrator wires:** `mount.ts` places your `stage` and `wood` in the Table for the boss, audit and Apply nodes.

---

## What the integrator does next

- Swap each stub for the worker's component as it lands, behind `#play-ui`, then make `#play-ui` the default route and retire the slice.
- Replace `ribbonLayer` with the room/rig `RibbonLayer`.
- Keep `contract.ts` and `adapter.ts` in step with any field a worker asks for, each with a test.
- Run five cold players on the sample at hour 8–12 (`design/cold-player-test-brief.md` in the lead's folder).
