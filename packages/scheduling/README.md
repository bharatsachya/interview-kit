# @trao/scheduling

Day-by-day allocation. Pure, deterministic, **no model anywhere near it**.

Imports `@trao/contracts` and `@trao/kit`. Questions plus a day count in, a schedule out — no
network, no I/O, no clock.

The brief says twice that allocating topics across the available days is the application's job. A
prompt that returns a schedule loses the points even when the output looks fine.

## The policy

1. Sort every active question by **urgency** — `difficulty × priority`, hardest and most
   important first (`weight.ts`).
2. Fill days in order up to a per-day minute target, moving on only once a day has something on
   it and is at or over target. Because the list is sorted, day 1 necessarily gets heavier
   material than day 2: **harder work lands early, not the night before.**
3. Anything left when the last day is reached goes on the last day. Nothing is ever dropped — a
   must-have that fell off the end would be a coverage failure caused by the scheduler.
4. Days still empty become **spaced review days**, cycling back through the material by urgency.

Minutes come from `minutesForDifficulty` in `@trao/kit`, so the number on a day and the number on
a question can never disagree.

## The two edge cases the tests are built around

**1 day.** Everything lands on it. The day is over target and says so; it does not silently drop
the tail.

**60 days.** With 20 questions the alternative to review days is thin days, which leaves 40 days
empty — and an empty day reads as broken however valid it is. Revisiting material after learning
it is also what anyone would actually advise with two months to prepare. Cross-day repeats are
therefore legal in the kit schema; a repeat *within* one day is not.

## Focus text

`assignFocuses` names each day after what is on it (`subjectOf`), derived from the questions'
requirements. `EMPTY_DAY_FOCUS` covers the day that genuinely has nothing.

## Repair is deliberately not here

`repairSchedule` lives in `@trao/kit` instead, because repair must be **minimal-disturbance**
rather than a re-allocation — it has to leave the days the user edited byte-identical while
placing new questions and removing archived ones. Re-allocating would wipe them. See
`docs/DECISIONS.md`.

`reallocateSchedule` is the rebuild-on-request path: days flagged `edited` come back
byte-for-byte, everything not on one of those days is reallocated across the rest.

## Tests

`test/allocate.test.ts` — 1 day, 60 days, front-loading, nothing dropped, edited days preserved.
Schedule allocation is one of the three areas the brief names by hand.
