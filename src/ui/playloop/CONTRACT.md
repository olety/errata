# Play-loop contract (frozen 2026-10-07 for P1)

`contract.ts` is the only file the four workers import from the play loop core. It holds view types, the drag intent, stamps, results and pure copy selectors. It never touches the engine.

`adapter.ts` is the only play-loop module that imports the engine. Its `select*` functions turn the game state into views. Its `act*` functions are the only transitions. Every number in a view is computed there, with its honesty-map source (play-loop §13) named in a JSDoc line.

`controller.ts` owns the one `PlayState`, routes input to `act*`, and hands views to components. `drag.ts` turns pointer and keyboard input into `DragIntent`s.

```
engine (src/*.ts, src/deck/*)  ←  adapter.ts (select* / act*)  ←  controller.ts (state machine, keys, tap-tap)
                                                                       │ views ↓        ↑ intents
                                                    workers: cards/ layout/ room/ campfire/ end/
```

## Rules for workers

1. Import types and selectors from `contract.ts` only. Never import `adapter.ts`, the engine, or another worker's folder.
2. Never compute a number. Render the view's number, with `COPY.estimated` beside every token figure.
3. Take copy from `COPY`, `pipsText`, `footerText`, `overflowText`, `ghostText`, `casesText`, `failWord` and `bossReason`. Never write "prevented", "killed", "defeated", "damage", "saved time", "worked" or "fired".
4. Raise intents through the callbacks the controller passes (`ControllerApi`). Components never hold game state.
5. Animate only what a result says happened: `PlayResultView.bound` in order for the bind cascade, `standing` for the strike. Never bind optimistically.
6. Register drop targets through `drag.ts` with real rectangles of at least 44 by 44 px. Open is never a drop target.
7. Every string from a log is text, never HTML. Inline code arrives as backtick spans; render them as `<code>` elements.

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
| `Screen` | `selectScreen` | controller |

## Acts

| Act | What it does | Finalizes a room? |
|---|---|---|
| `actStamp(caseId, stamp)` | Stamps one head while judging. Refused while dealt or done. | No |
| `actFocusReceipt(caseId)` | Puts any head's receipt on the stage. | No |
| `actDeal()` | Deals the hand: only drafts with observed eligibility. Reversible. | No |
| `actPullBack()` | Returns a dealt hand so stamps can change. | No |
| `actPlay(cardId, 'beast' \| 'claude' \| 'codex')` | Adds the card, accepts only glowing heads, returns true cover results. A refused beast drop changes nothing. | **Yes**, on success |
| `actSkip()` | Shelves the dealt hand, free. A drop on the shelf is the same act. | **Yes** |
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
| `actReturnToCampfire(select)` | From an Apply blocker to the final campfire, with the blocker selected. | No |

A room's stamps are final once `actPlay` succeeds, `actSkip` runs, or `actAdvance` leaves it through an offer. The UI says so with `RoomView.finalizes` while the hand is dealt.

## Freeze

Workers may ask for a new field. The integrator adds it to `contract.ts` and `adapter.ts` together, with a test, and notes it here. Nobody else edits these files.
