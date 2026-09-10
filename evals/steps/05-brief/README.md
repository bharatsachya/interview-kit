# 05 — generateBrief

Target: `packages/generation` → `generateBrief(company, role, passages, deps)`

LLM. Run 3 times. Property assertions.

Assert per case:
- `hiring_process === ""` when `expected.hiring_process_empty` is true
- when `expected.hiring_process_must_mention` is set, each phrase appears in `hiring_process`
- when `expected.what_they_do_must_mention` is set, each phrase appears in `what_they_do`
- when `expected.must_not_mention` is set, none of those phrases appear anywhere in the brief
- `sources` ⊆ URLs of passages actually provided (never a URL that wasn't in the input)
- for `empty-input`: `what_they_do` contains one of `expected.honesty_markers`
