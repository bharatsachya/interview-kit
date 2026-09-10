# 06 — generateQuestions

Target: `packages/generation` → `generateQuestions(requirements, responsibilities, hiringContext, deps)`

Structural assertions run against `FakeLlmProvider` (recording calls). Content assertions
run against the real provider, 3 times.

Assert per case (fake provider):
- exactly 4 calls, one per category, in any order
- the technical call's prompt contains every technical requirement id and no behavioural id
- the behavioural call's prompt contains every behavioural id and no technical id
- the company-fit call's prompt contains the company brief text
- when `hiring_context` is non-empty, every category prompt contains it
- returned `requirement_ids` on every question ⊆ ids that were in THAT call's prompt

Assert per case (real provider):
- every question has non-empty `prompt`, `answer_outline`, `difficulty ∈ {1,2,3}`
- behavioural questions do not mention tools listed in `expected.tools_not_in_behavioural`
- when `expected.system_design_mentions` is set, at least one system-design question
  contains one of those phrases (proves hiring context changed the output)
