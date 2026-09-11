# 13 — builder: edit, delete, move, reorder, regenerate

Target: `packages/kit` mutation functions + `packages/pipeline` `regenerateSection(kit, section, deps)`

This is the 15-point human-review item. The brief: "Regenerating one section must not
discard edits the user has made elsewhere, and a question the user wrote or edited by hand
must survive a regeneration of its category."

Every case starts from `_fixtures/base-kit.json` (loaded as `input.kit` unless overridden),
applies `input.operations` in order, then asserts on the resulting internal kit AND on
`toKitJSON(result)`. Regeneration calls go to `FakeLlmProvider` scripted by
`input.fake_responses`.

Base kit summary — read this before reading cases:

    technical:     q1 gen, q2 gen, q3 EDITED, q4 gen+PINNED, q8 gen ARCHIVED
    behavioural:   q5 gen
    system-design: q6 gen
    company-fit:   q7 MANUAL
    schedule:      day 2 is EDITED by the user
    flashcards:    f3 EDITED; others derived from their question

Assert per case: everything under `expected`. Field names:
- `survives` / `removed` — question ids that must be active / must be inactive afterwards
- `origin` — expected origin per id
- `untouched` — ids whose full record must be byte-identical to base
- `new_questions_min` — at least this many new active questions in the category
- `category_of` — expected category per id
- `order_of` — expected relative order (array of ids) within a category
- `schedule_day_focus` — expected focus per day number
- `output` — assertions on `toKitJSON(result)`
- `llm_calls` — exact number of LLM calls made
- `version` — expected kit version after the operations (base is 7)
