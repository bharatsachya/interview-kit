# 11 — allocateSchedule + repairSchedule

Target: `packages/scheduling` → `allocateSchedule(questions, requirements, days, clock)` and `repairSchedule(schedule, questions)`

Pure. Exact where stated, property otherwise. Use the fixed Clock and IdGenerator.

Minutes table assumed by these cases: difficulty 1 → 15, 2 → 20, 3 → 30. If yours differs,
update `expected.total_minutes` — the invariants still hold.

Assert per case:
- `days.length === input.days`
- every must-priority requirement appears in some day's questions (via requirement_ids)
- every `minutes` is an integer > 0
- all question ids across days == all active question ids (no duplicates, none missing)
- `expected.day1_contains` ⊆ day 1's question_ids (priority-first front-loading)
- `expected.max_difficulty_by_day` is non-increasing (harder earlier)
- no `focus` equals a generic label ("Mixed practice", "Technical depth", "Practice", "Review")
- no `focus` starts with a lowercase letter or a stray capital from an off-by-one cut
- for repair cases: `expected.after_repair` matches exactly
