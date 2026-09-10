# 12 — toKitJSON

Target: `packages/kit` → `toKitJSON(internalKit)` → Appendix A kit, validated

Pure. Exact.

Assert per case:
- output passes the Appendix A Zod validator
- output contains NONE of: `origin`, `pinned`, `active`, `source_span`, `edited`,
  `hiring_signal`, `gaps` (internal fields stripped)
- `questions` contains exactly `expected.question_ids`
- `flashcards` contains exactly `expected.flashcard_ids`
- every `schedule.days[].question_ids` entry ∈ output `questions`
- `source` block present with all seven fields; `role` has `title`, `seniority`,
  `responsibilities`, `requirements`
- `coverage.uncovered_requirement_ids` equals `expected.uncovered`
