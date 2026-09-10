# 09 — buildFallbackQuestion

Target: `packages/generation` → `buildFallbackQuestion(requirement, roleTitle)`

Pure. Exact on shape, property on content.

Assert per case:
- `origin === "fallback"`
- `category` equals `expected.category`
- `requirement_ids` equals `[requirement.id]`
- every content token of `prompt` (after removing template words) appears in
  `requirement.text`, `requirement.source_span`, or `roleTitle` — nothing else
- `prompt` contains `expected.must_contain`
- `difficulty ∈ {1,2,3}`, integer
- NO LLM call was made (assert fake provider call count unchanged)
