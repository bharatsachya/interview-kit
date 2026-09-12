# @trao/kit

The kit document: its internal shape, the Appendix A projection, and every state transition the
builder performs on it.

Imports `@trao/contracts` and zod, nothing else. Imported by anything producing kit-shaped data.

**This is the 15-point item.** The brief says it will look hardest at one thing: *regenerating
one section must not discard edits made elsewhere, and a question the user wrote or edited by
hand must survive a regeneration of its category.* Every design choice below follows from that.

## Provenance: four fields that never reach the output

Every question and flashcard carries them, and `toKitJSON` strips them:

| Field | Meaning |
|---|---|
| `origin` | `generated` · `edited` · `manual` · `fallback` |
| `pinned` | the user asked for this to be kept |
| `active` | soft delete — false means gone from every projection |
| `order` | position within its category |

`origin` and `pinned` are separate on purpose. "I changed this" and "keep this" are different
intents; conflating them would silently opt a user out of ever regenerating their own edits away.

**Nothing is ever deleted and no id is ever reused.** Deletion is a flag, which is what makes a
dangling reference impossible in storage.

## The two projections

Both run schedule repair, so they can never disagree about which questions exist:

* `getKitForBuilder(kit)` — active items, provenance intact. What the UI reads.
* `toKitJSON(kit)` — Appendix A exactly, provenance stripped, validated. What batch output and
  export produce. Every field is **constructed by hand** rather than spread, so a field that is
  not named here cannot leak. `tryToKitJSON` is the same thing for callers that must record a
  validation failure instead of throwing.

## Repair lives at the serialize boundary

`repairSchedule` runs inside both projections, never on a write path. An archived question
therefore leaves its day when the kit is next projected, and a new question is placed then too —
so no write path ever has to touch `schedule`, which is precisely what would wipe a day the user
rewrote by hand.

## Transitions

`edits.ts` holds them all: `editQuestion`, `addManualQuestion`, `moveQuestion`,
`reorderQuestions`, `pinQuestion`, `deleteQuestion` (archive), `editBrief`, `editScheduleDay`,
`regenerateCategory`, and the flashcard equivalents. All pure, all `(kit, …) => kit`.

`fork.ts` holds `forkKit`, which is what a rewrite does instead of overwriting — the input is
untouched, `version` restarts at 1, `revision` increments, and every id *inside* the document is
kept so the schedule and the practice deck still resolve.

## Versioning

`commit(kit, options, changes)` is the only thing that bumps `version`, and therefore the only
thing that checks `ifVersion`. Keeping the check and the bump in one function is what makes it
impossible to write a mutation that checks and forgets to bump — a mutation that does not bump is
invisible to the next writer's check.

## Appendix A and B

`appendix-a.ts` is the frozen kit structure as a zod schema plus `validateKitJSON`.
`appendix-b.ts` is the frozen batch shape: `parseCases`, `parseCasesJSON` (which the web
uploader also uses, so one parser serves both) and `validateEvaluationOutput`.

## Tests

`test/edits.test.ts`, `test/projections.test.ts`, `test/repair.test.ts`, `test/fork.test.ts`,
`test/validation.test.ts`, `test/appendix-b.test.ts`. Structure validation is one of the three
areas the brief names by hand.
