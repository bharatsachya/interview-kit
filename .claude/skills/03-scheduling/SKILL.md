---
name: 03-scheduling
description: Implement day-by-day study schedule allocation and schedule repair as pure deterministic code with no LLM involvement. Use this skill whenever working on packages/scheduling, distributing questions across days, the days_available field, day focus text, integer minutes, front-loading harder material, the 1-day or 60-day edge cases, or repairing a schedule after questions change. Trigger this whenever someone suggests letting the model build the schedule — the brief says twice that allocation is arithmetic and must live in code.
---

# Scheduling — pure allocation

Block H3. Mandatory test area: **schedule allocation**.

## The rule that matters most

**The model never touches this.** The brief states it explicitly: allocating topics across the
days available is arithmetic and the application should do it. A prompt that produces a
schedule loses points even if the output looks fine.

Same for repair. No LLM anywhere in this package. No network. No I/O. It takes questions plus
a day count and returns a schedule.

## Requirements from the brief

- Every day has a focus, a set of question ids, and an integer duration in minutes.
- Every must-have requirement appears somewhere in the schedule.
- `days.length` equals `days_available` **exactly**.
- Harder and higher-priority material lands earlier, not the night before.

## Allocation

Weight by `difficulty × priority`, sort descending, distribute front-loaded across the
available days. Day focus is derived from the dominant requirement `kind` or the most common
topic among that day's questions — derived in code, not generated.

Minutes per question by difficulty (fixed table, integer). Day total is the sum. Never a float.

## Edge cases

- **1 day:** everything on day 1. Nothing dropped.
- **60 days:** decide a policy and document it in the README. Either spaced review days
  repeating earlier material, or thin days with less per day. Both are defensible; pick one so
  the test has something to assert.
- **More days than material:** no day may be structurally broken or missing.

## Repair

Called from `toKitJSON` and `getKitForBuilder`, not from write paths.

1. Drop question ids from days that are archived or no longer exist.
2. Place active questions that appear in no day.

Days carry `edited: true` once the user touches them. **Recompute skips edited days** —
regenerating a question category must not wipe a day focus the user rewrote. This is the same
provenance idea as questions, applied one level up.

## Tests (mandatory area — write all of these)

- `days.length === days_available` for 1, 5, 30, 60.
- Every must-have requirement appears somewhere.
- `Number.isInteger` holds for every `minutes` value.
- Harder / higher-priority material lands in earlier days than easier material.
- Every `question_ids` entry resolves to a question that exists.
- 1-day case places everything and drops nothing.
- 60-day case produces exactly 60 days under the chosen policy.
- Repair drops archived ids from days.
- Repair places a newly-active unscheduled question.
- An `edited: true` day survives a recompute unchanged.

Use the fixed `Clock` and `IdGenerator` from contracts so results are deterministic.

## Done when

All ten tests pass with no network, no database, and no API key.
