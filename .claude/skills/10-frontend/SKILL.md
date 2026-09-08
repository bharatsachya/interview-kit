---
name: 10-frontend
description: Build the Next.js interface — create form, generation progress, kit view, the builder with inline editing and reordering and section regeneration, and practice mode with flashcards and confidence tracking. Use this skill whenever working on apps/web or apps/api routes, React components, Tailwind styling, loading empty or error states, drag and drop reordering, optimistic updates, keyboard navigation, Clerk auth in the UI, or the flashcard stepper. Trigger this whenever a UI surface is being added — the brief lists exactly which screens exist and anything beyond that list is out of scope.
---

# Frontend

Blocks H10–H13. Worth 45 points across the builder, interaction design, and practice mode.

## The UI surface is exactly what the brief lists

Nothing more. No gap worklist, no removed-items section, no unscheduled bucket, no greyed-out
slots. If it is not below, it is out of scope.

- **Auth** — register, login, logout via Clerk. Signed-out visitors reach nothing. Users see
  only their own kits.
- **Create** — JD textarea, company website field, days field, and multi-role input.
- **Generating** — visible progress, clear failure states.
- **Kit view** — company brief, role breakdown, questions by category, flashcards, schedule.
- **Builder** — inline edit of any question, answer outline, flashcard or brief. Reorder
  questions. Move a question between categories. Add by hand. Delete. Regenerate the brief,
  one question category, or the schedule.
- **Practice** — one flashcard at a time, reveal answer, record confidence, show covered and
  not covered, order next session by lowest confidence.

## Build the builder before practice

The builder is **15 points**, practice shares 10 with the creative feature. If the day runs
long, it runs long on practice.

## Progress reporting: polling, not SSE

Poll every 2 seconds. Free hosts buffer streams and a broken progress bar in the walkthrough
video costs more than a plain working one. Generation is a background job returning a `job_id`
immediately — a 90-second HTTP request dies on free-tier hosts.

Read step progress from the job's trace spans so the UI shows real steps, not a fake spinner.

## The builder rules

Regenerating one section **must not discard edits made elsewhere**, and a question the user
wrote or edited by hand **must survive a regeneration of its category**.

The state model is in skill `02-kit-structure` — read it before touching regeneration.
The UI reads `getKitForBuilder`, which returns active items with provenance flags. Archived
items never appear. Deleted means gone from the user's view.

## Multi-role input

Accept **the same JSON shape as `cases.json`** from Appendix B. One parser serves both the UI
upload and the batch path, and the demo writes itself.

## Interaction design — 10 points

- Clear **loading, empty and error states** everywhere, not just on generation.
- Editing and reordering feel **immediate**: optimistic local state, debounced persistence.
  No round-trip per keystroke.
- **Usable on a laptop and a phone.**
- **Keyboard navigable** — especially the flashcard stepper and the reorder controls. People
  forget this and it sits inside the 10 points.

The rubric: "how you handle a long-running generation, a partial failure, an edit in flight,
and a regeneration that must not clobber someone's work." Polish is welcome but is not the
point.

## Practice mode

- Step through flashcards one at a time, revealing the answer.
- Record confidence per card.
- Show what has been covered and what has not.
- **Order the next session by lowest confidence.** A simple confidence-weighted sort is fine;
  a spaced-repetition interval is fine. Pick one and defend it in the README.

Practice sessions live in their own collection, not embedded in the kit document — they grow
unbounded.

## Clerk

The Express API verifies Clerk tokens itself via JWKS, not only the Next.js side. Budget time
for this; it is not free. Auth is explicitly **not scored** beyond working, so keep it minimal —
no email verification, no password reset, no roles.

## Done when

A kit can be created, watched, edited, reordered, regenerated without losing edits, and
practised — on a phone, with a keyboard, with visible states at every stage.
