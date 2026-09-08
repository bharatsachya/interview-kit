---
name: 02-kit-structure
description: Define the Appendix A kit structure, the Zod validator, the two projections (getKitForBuilder and toKitJSON), the soft-delete state model, and schedule repair at the serialize boundary. Use this skill whenever touching packages/kit, the kit JSON shape, field names, validation, provenance flags (origin, pinned, active), archiving or deleting questions and flashcards, regenerating a section without losing edits, or anything about dangling question_ids. Trigger this whenever someone asks how edits survive regeneration, or where repair should happen — this is the hardest state problem in the assessment and it is worth 15 points.
---

# Kit structure and state model

Block H2. Mandatory test area: **structure validation**.

## Appendix A is frozen

Field names must match exactly. The structure may be extended, but nothing may be renamed or
omitted. Conformance details that are easy to get wrong:

- `difficulty` is 1–3 (integer).
- `minutes` is an integer. No floats, no "about an hour".
- `location` is required and has no obvious source — extract from the JD if present, empty
  string otherwise. Leaving it `undefined` fails your own validator.
- Every requirement has a stable id; every question lists the requirement ids it covers.
- Every `schedule.days[].question_ids` entry must refer to a question that exists.

## Internal shape ≠ output shape

Storage carries fields Appendix A never sees. This is deliberate — the projection is the
contract, so the output spec never constrains the database.

Per question and flashcard:

```ts
origin: "generated" | "edited" | "manual" | "fallback"
pinned: boolean
active: boolean
```

`edited` and `pinned` are separate on purpose: "the user changed this" and "the user wants this
kept" are different intents.

## Soft delete

Questions and flashcards are **never removed internally**. Deletion sets `active: false`.
IDs are never reused. This makes dangling references impossible in storage.

**Archived items are invisible in the UI.** The brief says "delete", not "archive" — there is
no Removed list, no restore button, no greyed-out slots. The flag is purely internal integrity.
Because storage keeps the id in the day, a restore would silently return a question to the day
it was on.

## Regeneration

Regenerating a category deletes only items where `origin === "generated" && !pinned`.
Everything else survives — edited, manual, pinned, and anything in other categories.

## Two projections

```ts
getKitForBuilder(kit)
  // active items only, provenance flags intact,
  // days filtered to active questions
  // → used by the API serving the UI

toKitJSON(kit)
  // active only, schedule repaired, provenance stripped,
  // validated against Appendix A
  // → used by batch output and export
```

## Repair lives at the serialize boundary

Not on write, and **not in a background job**.

- Writes stay dumb — the regenerate endpoint swaps questions and saves, no integrity logic.
- Not a background job because: batch mode generates and exits in ~12 minutes so a cron never
  gets a turn; the video demo would show a visibly broken schedule; free hosts sleep. The
  repair is a set intersection over an in-memory document — microseconds. Deferring it buys
  nothing and adds a window where the data is wrong.

Repair does two things: drop dead or archived question ids from days, and place active
questions that are not scheduled anywhere.

Both projections run placement so the two views always agree and no kit ever looks half-built.

## Tests (mandatory area — write all of these)

- A valid kit passes the schema.
- `difficulty: 4` fails. `difficulty: 0` fails.
- `minutes: 45.5` fails.
- Missing `location` fails.
- A question referencing a nonexistent requirement id fails.
- `toKitJSON` drops archived questions from both the question list and the schedule days.
- `toKitJSON` places an active question that was in no day.
- `getKitForBuilder` retains provenance flags; `toKitJSON` does not emit them.
- Regenerating a category keeps `edited`, `manual` and `pinned` items and drops only
  unpinned generated ones.

## Done when

The validator rejects every malformed case above, and a kit that has been through
archive → regenerate → serialize still passes Appendix A validation with no dangling ids.
