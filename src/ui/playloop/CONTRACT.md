# Play-loop contract (frozen 2026-10-07 for P1; P2 additions at the end)

`contract.ts` is the only file the four workers import from the play loop core. It holds view types, the drag intent, stamps, results and pure copy selectors. It never touches the engine.

`adapter.ts` is the only play-loop module that imports the engine. Its `select*` functions turn the game state into views. Its `act*` functions are the only transitions. Every number in a view is computed there, with its honesty-map source (play-loop §13) named in a JSDoc line.

`controller.ts` owns the one `PlayState`, routes input to `act*`, and hands views to components through `ControllerApi`. `drag.ts` turns pointer input into drags, taps and long-presses and resolves drops by hit-testing registered targets. `geometry.ts` computes the bands. `mount.ts` composes the workers' components per screen; `debug.ts` is the plain render on `#play`.

```
engine (src/*.ts, src/deck/*)  ←  adapter.ts (select* / act*)  ←  controller.ts (state machine, keys, tap-tap)
                                                                       │ views ↓        ↑ intents
                                                    workers: cards/ layout/ room/ campfire/ end/
```

## Rules for workers

1. Import types and selectors from `contract.ts`, and the base layer's components from `cards/index.ts` and `layout/index.ts`. Never import `adapter.ts`, the engine, or another worker's internals.
2. Never compute a game or data number (counts, weights, coverage): render the view's, with `COPY.estimated` beside every token figure. Presentation maths (measuring rectangles, spacing sprites, fitting text) is yours.
3. Take copy from `COPY`, `pipsText`, `footerText`, `overflowText`, `ghostText`, `casesText`, `failWord` and `bossReason`. Never write "prevented", "killed", "defeated", "damage", "saved time", "worked" or "fired".
4. Raise intents through the callbacks the controller passes (`ControllerApi`). Components never hold game state.
5. Animate only what a result says happened: `PlayResultView.bound` in order for the bind cascade, `standing` for the strike, and `UiView.effect` (bound and unbound cases) for every other committed change. Animate each result or effect once per `id`. Never bind optimistically.
6. Register drop targets through `drag.ts` with real rectangles of at least 44 by 44 px. Open is never a drop target.
7. Every string from a log is text, never HTML. Inline code arrives as backtick spans; render them as `<code>` elements.
8. A line is read before it is accepted (§0a.5). A pointer drag shows the reading on hover. Selecting a dealt card shows its beast reading. Tap–tap or a key aimed at a target whose reading is not on screen only shows it (`UiView.pending.kind === 'confirm'`); the same act again plays. Dealing selects the first card, so one Enter plays a line already shown.
9. No room finalizes with an unstamped head (`RoomView.review`). "Unclear · leave wrapped" is a stamp. Deal, skip and Continue wait for `canFinalize`.

## Drop dispatch

| Source | Target | Meaning |
|---|---|---|
| Room draft (hand) | The beast or any of its heads | Play on the beast: export to the glowing heads' agents. Refused without spending the pick when nothing glows. |
| Room draft | A book | Play into that file only; may add a zero-match line. |
| Room draft | The shelf | Skip. |
| Workshop draft | The bench (beast target) or a book | Forge: the card and its Skill join the proposal; lanterns never glow; nothing is accepted. |
| A card in the proposal (`RoomView.deck`) | A standing head | Accept that one mapping when it is eligible. |
| Campfire deck card | Another deck card | Propose the whole gold thread (fuse) or the red pair (settle); a pair with no thread is refused. |
| Campfire deck card | The fire | Propose a cut. |
| Campfire deck card | The other book | Propose widening to both. Narrowing is the inspector's target chips (`campfire.retarget(cardId, targets)`). |
| Campfire shelf card | A deck card of the same family | Propose a swap. |
| Boss deck card | The current head, once stamped a problem | Answer: accept the mapping when the candidate glows. |
| Anything else | Any | Refused with a notice; nothing changes. |

Target ids must be unique per rendered instance (`card:<id>:<where>`). One card may render in several places; every rendering may bind as a drag source.

## Types and who consumes them

| Type | Produced by | Consumed by |
|---|---|---|
| `RoomView` | `selectRoom` | room/rig (beast, heads, receipts), cards/layout (hand, books, piles), controller |
| `BeastView`, `HeadView`, `OverflowView`, `PipsView` | inside `RoomView` | room/rig |
| `ReceiptView` | inside `RoomView`, `BossView`, `PilesView` | room/rig (stage), boss/apply (reveal), cards/layout (inspector) |
| `CardView`, `CardFaceView`, `CardInspectorView` | inside every view | cards/layout renders all cards; campfire and end reuse its `Card` component |
| `BookView`, `PilesView`, `OpenPageView` | `selectBooks`, `selectPiles` | cards/layout (books, straps, shelf, Open rail); campfire (books at the fire) |
| `GhostDelta` | inside `DragPreview`, `ChangePreviewView` | cards/layout (strap ghost), campfire (seal preview) |
| `RouteView`, `RouteKnotView`, `StatusView` | `selectRoute`, `selectStatus` | cards/layout (header route, status bar) |
| `DragTarget`, `DragIntent`, `DragPreview`, `HeadGlow` | `selectDrag` via `drag.ts` | every worker renders the glow, the words, the ghost line and the strap ghost |
| `Stamp`, `STAMPS` | contract | room/rig (receipt stamps), boss/apply (blind stamp) |
| `PlayResultView` | `actPlay`, `actSkip` | room/rig (bind cascade, strike, boat or sink), cards/layout (ink) |
| `CampfireView`, `ThreadView`, `ChangePreviewView`, `LaneTab` | `selectCampfire`, `selectChangePreview` | campfire |
| `BossView`, `BossHeadView`, `BossCandidateView` | `selectBoss` | boss/apply |
| `ApplyView`, `ApplyDiffView`, `ApplyBlockerView`, `InkState` | `selectApply` | boss/apply (presentation only) |
| `Screen` | `selectScreen` | controller, `mount.ts` |
| `UiView` | `Controller.uiView()` | every worker: selection, the resolved inspector, live drag preview, the last committed effect, beat, reduced motion, bands, notice, pending proposal, tutorial |
| `InspectorView`, `MappingReviewView`, `ReadingView` | `selectInspector`, inside previews | cards/layout (the one inspector); campfire (needsAcceptance → `acceptMapping(resultId, caseId)`) |
| `CommitEffectView` | `Controller` around each act | room/rig (binds after an accept or a boss answer), campfire (reopened cases after a cut) |
| `RunSummaryView` | inside `ApplyView` | boss/apply (the end screen) |
| `Bands`, `Band` | `layout()` in `geometry.ts` | cards/layout (Table, hand, books, piles), room/rig (creature height, shore) |
| `ControllerApi` | `Controller.api` | every worker: the only way to act |
| `DropBinder` | `mount.ts` (over `DragCore`) | every worker that renders a card or a target |
| `ScreenProps<V>` | `mount.ts` | `RoomScreen`, `EventScreen`, `CampfireScreen`, `BossScreen`, `ApplyScreen` |
| `SettleChoice` | contract | campfire (the four settlement slots) |

## Acts

| Act | What it does | Finalizes a room? |
|---|---|---|
| `actStamp(caseId, stamp)` | Stamps one head while judging. Refused while dealt or done. | No |
| `actFocusReceipt(caseId)` | Puts any head's receipt on the stage. | No |
| `actDeal()` | Deals the hand: only drafts with observed eligibility. Reversible. | No |
| `actPullBack()` | Returns a dealt hand so stamps can change. | No |
| `actPlay(cardId, 'beast' \| 'claude' \| 'codex')` | Adds the card, accepts only glowing heads, returns true cover results. A refused beast drop changes nothing. | **Yes**, on success |
| `actSkip()` | Shelves the dealt hand, free. A drop on the shelf is the same act. Refused until every head is stamped. | **Yes** |
| `actAdvance()` | Leaves the node. A room must be done, or offer Continue, or be an event set aside. Marks such a room done. | **Yes**, for a room left through an offer |
| `actAnswerExisting(cardId, caseId, yes)` | "Already in your file. Does it answer this case?" | No |
| `actAcceptOnHead(cardId, caseId)` | A card already in a book dropped on a standing head. | No |
| `actWording(roomKey, text)` | The player's wording of the line, before dealing. | No |
| `actTab`, `actFocusPair`, `actPin` | Campfire lane tab, focused pair, pinned Open receipt. | No |
| `actFuse(threadId, text)` | Seals a fuse. | No |
| `actSettle(threadId, resolution)` | Settles a red thread; cancel leaves it. | No |
| `actCut(cardId)`, `actRestore(cardId)` | Cut into the fire; restore from the ash list until Apply. | No |
| `actSharpen`, `actRetarget`, `actSwap`, `actAcceptMapping`, `actAcceptImport`, `actRaiseAllowance` | The inspector's edits, a book re-target, a shelf swap, mapping approvals, the explicit allowance raise. | No |
| `actBossStamp(caseId, stamp)` | The blind stamp; locked on click. | No |
| `actBossAnswer(cardId, caseId)` | The answer drag; only an eligible card binds. | No |
| `actBossNext()`, `actLockScore()` | Continue past a head; lock the score to the deck revision. | No |
| `actPrepareApply(port)`, `actSeal(port)`, `actUndo(port)` | The engine's guarded write with backups and read-back, and Undo. Async. | No |
| `actGrant(port, which)` | A folder grant: the deck is rebased on the files as read now, then the diff is rebuilt. | No |
| `actReturnToCampfire(select)` | From an Apply blocker to the final campfire, with the blocker selected. | No |

A room's stamps are final once `actPlay` succeeds, `actSkip` runs, or `actAdvance` leaves it through an offer. The UI says so with `RoomView.finalizes` while the hand is dealt.

## Freeze

Workers may ask for a new field. The integrator adds it to `contract.ts` and `adapter.ts` together, with a test, and notes it here. Nobody else edits these files.

## P2 additions (integrator, 2026-10-07)

Each field below has a test in `tests/playloop-p2.test.ts`.

| Field or act | Asked by | What it is |
|---|---|---|
| `CardView.sealed`, `CardView.type` | engine gap | Sealed protected text (the sample's Notes line) keeps type `protected` and `sealed: true`: it weighs, never stacks, settles or burns (`SEALED`). Lines read from your file that are instructions are `rule` cards. |
| `CardView.art` (`CardArt`) | cards | The art plate from the card's family; null for protected text and traits. |
| `HeadGlow.tag` | cards | Agent, project and date of each glowing or turned-aside head. |
| `ChangePreviewView.refs` | campfire | Every case a preview names (opened, addressed, needs acceptance) with its tag. |
| `BossView.skin` | boss/apply | The run's largest family skin; the boss wears that skin's room plates. |
| `InkState` `'undone'` | boss/apply | After a successful Undo the three stamps read undone, never still inked. |
| `BookView.raiseSteps`, `actRaiseAllowance` checks | lead | The buckle's offers (three steps above the allowance and the weight); a raise goes only upward, in whole tokens, on a read file. |
| `RoomView.scope`, `api.confirmProject`, `actConfirmProject` | engine gap | The scope chip: confirm one project while judging a room whose heads span projects; drafts carry that scope, so check 4 turns other projects' heads aside. |
| `UiView.tutorial` | integrator | Filled by `tutorial.ts` on the sample: one coach line per gesture, with a card or thread spotlight. |
| Controller guards | campfire, boss/apply, cards | A card dropped on itself or on sealed text is refused with a notice; Enter at the fire leaves only when no proposal is up; arrow keys select through `api.select`; `boss.next()` clears the selection. |

## P3 additions (lead, 2026-10-07, from the cold-player gate)

Each field below has a test in `tests/playloop-p3.test.ts`, `tests/playloop-contract.test.ts` or `tests/e2e.test.ts`.

| Field, act or selector | What it is |
|---|---|
| `pipsText`, `footerText`, `casesText`, `ghostText`, `strapText`, `provenanceText`, `sealedText`, `clearText`, `SEALED_WHY`, `BLOCK_HEADER_WHY` | The gate's honesty wording: "0 of 3 cases answered by a proposed line", "answers 3 cases here", "cases answered by the whole deck: 3 → 3 (this change affects 0)", "+46 line · +22 block header (the one-time marker lines)", "file weight 104 of 1,200 tok" / "room left 1,096", "seen in 3 sessions", "2 later cases held for the boss", the clear line. Token figures say "tok" on faces and "tokens, estimated" in the inspector. |
| `CardArt` | One plate per family: wyrm, retry, scope, moth, verify, imported (an inked book; no creature). |
| `RoomView.clear`, `RoomView.handDiffers`, `RoomView.scope.hint` | The clear line after a play or skip; one line naming how a multi-card hand differs; the local-words line under a global scope. |
| `ThreadView.shared`, `ThreadView.newer` | A gold thread's shared content words and their share (preview only); a red pair's newer member (Keep one starts on it). |
| `ChangePreviewView.changed` | The files whose bytes a seal would change; previews name only these. |
| `Bands.flow` | Below 500 px the Table is a scrolling page; the room's controls stick above the status strip. |
| `ApplyView.exported` | A browser without folder access: each file's managed block and a download name ("Exported, not applied"). |
| `ApplyView.remember`, `api.apply.remember(on)`, `ApplyPort.canWrite/remember/remembered`, `applyRecord` | The second visit: keep the receipt and the stable line ids (and, in the app, the folder grants) only on the player's click. |
| `DragHooks.onTap(cardId, under)`, `targetLabel` | A tap on another card while one is selected stacks it when that card is a target; every drop target is a named button for assistive tech and the keyboard. |
| `CardProps.onActivate` | Cards are focusable buttons; Enter or Space selects (or stacks at the fire). |

## P4 additions (lead, 2026-10-07, the freeze leg)

Each field below has a test in `tests/playloop-p4.test.ts`.

| Field, act or selector | What it is |
|---|---|
| `strapText` → `{ title, used }`, `BUDGET`, `overBudgetText`, `fitsText`, `FITS_WHY` | Every budget label says budget: the strap reads "token budget" over "104 of 1,200 used · 1,096 left"; the open clasp "over budget by 30"; the end screen "both files within budget" or "CLAUDE.md over budget by 30"; the Fits stamp's title "Fits: within the budget you chose · …". No UI string says weight, weighs or allowance (a source sweep in the test). |
| `ghostText` | The ghost while dragging: "+46 tok (+22 header, once)", "−19 tok", "+60 tok · −1 rounding". |
| `CardView.cost`, `costText`, `BLOCK_HEADER_LONG` | Hand cards whose play adds the managed block header: "+46 tok · +22–23 once" on the footer's second row (the provenance yields there, as at S), per-file figures, and the exact marker lines the play adds, which the inspector names. |
| `BossView.score.unjudged`, `RunSummaryView.unjudged`, `UnjudgedLineView` | The tally names each line from your files whose suggested reading is not yet judged: "1 line not yet judged: 'Report what you changed…'". The boss slip, the live tally and the end screen's tally render each quoted excerpt as a link (`linkedLine`) that opens the card's inspector. |
| `CardInspectorView.importJudgment`, `api.campfire.declineImport`, `actDeclineImport` | The inspector row for such a line: Accept this reading, or Does not apply. Does not apply keeps the file as it is, records the judgment for the line's current text (`DeckState.declinedImports`; an edit asks again), counts in the deck revision (a locked score goes stale and offers Lock the score again), and takes the line off the tally's not-yet-judged list. Accept replaces it. |
