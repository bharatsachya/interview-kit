# 08 — coverageLoop

Target: `packages/coverage` → `coverageLoop(kit, requirements, { llm: FakeLlmProvider, maxExtraPasses: 2 })`

Pure control flow with a scripted fake. Exact.

`input.fake_responses` is the ordered list of what the fake LLM returns, keyed by the
requirement id it was asked about. Each entry is the response for one gap-fill call.

Assert per case:
- `coverage.passes` equals `expected.passes`
- the fake was called exactly `expected.llm_calls` times, in `expected.call_order`
- final `uncovered_requirement_ids` equals `expected.uncovered`
- accepted/rejected per call equals `expected.outcomes`
- the fake was called with ONE requirement per call, and the resulting question's
  `requirement_ids` were assigned by the caller (equal to that requirement id), never
  taken from the fake's response
