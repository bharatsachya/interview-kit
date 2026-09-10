# 10 — deriveFlashcards

Target: `packages/generation` → `deriveFlashcards(questions)`

Pure. Exact.

Assert per case:
- one card per question, `requirement_ids` copied verbatim
- `front` equals `expected.front`
- `back` equals the question's `answer_outline`
- no `front` ends with "…" or "..."
- every `front` ends with terminal punctuation
- zero LLM calls
