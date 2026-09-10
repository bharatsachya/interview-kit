# 07 — applyGates + findGaps

Target: `packages/coverage` → `applyGates(questions, requirements)` then `findGaps(questions, requirements)`

Pure. Exact.

Assert per case:
- after gating, each question's `requirement_ids` equals `expected.retagged[qid]`
- `expected.dropped` entries appear in the trace as `qid:rid=reason`
- `findGaps` returns exactly `expected.gaps` (must-priority only)
- `expected.rejected_questions` are removed entirely (duplicates / empties)
