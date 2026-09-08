---
name: 05-llm-gateway
description: Build the single LLM gateway with RPM and TPM token buckets, request queueing, exponential backoff with jitter, Retry-After handling, JSON repair, prompt caching, and the FakeLlmProvider. Use this skill whenever working on packages/llm, calling Gemini or any model provider, handling 429s or rate limits, tokens-per-minute limits, free-tier quota, caching model responses, or invalid JSON from a model. Trigger this whenever any code is about to call a model provider directly — nothing outside this package is allowed to.
---

# LLM gateway

Block H4. Everything downstream depends on this, and the `FakeLlmProvider` it exposes is what
unblocks the rest of the build.

## The budget you are working inside

Gemini free tier is roughly 10–15 RPM and 250,000 TPM, with RPD in the low hundreds for
2.5 Flash. **Limits apply per project, not per API key** — key rotation buys nothing.

Per case: 1 extract + 1 brief + 4 categories + ~1 gap fill ≈ 8 calls. Five cases = 40 calls.
At 10 RPM that is 4 minutes of queueing inside the 15-minute batch budget.

**RPD is the real problem during development, not TPM.** Without caching you get about six
full batch runs a day. The cache is not an optimisation, it is what makes the day possible.

Design for **exactly one API key** — the graders supply their own via `.env.example`.

## One gateway, no exceptions

Every LLM call goes through `llm.call()`. Nothing else in the repo touches the provider. One
place to reason about, one place to test.

The gateway holds:

- Separate **RPM and TPM token buckets** (TPM is the one people forget).
- A queue — requests wait rather than firing and failing.
- Exponential backoff with **jitter**.
- `Retry-After` honoured when the provider sends it, overriding the backoff default.
- **Cache lookup before spending**: `sha256(model + prompt)` → response.
- **JSON repair**: on invalid output, one retry with the validation error fed back. Then fail
  cleanly and let the caller record a skipped step.
- Token estimation before the call so the TPM bucket can hold a request back rather than
  discovering the limit reactively.

## Budget object

Runs carry `{ maxCalls, maxTokens, deadline }`. Steps check before spending. When exhausted,
the pipeline ships what it has with honest gaps. A partial kit is `ok`; only a kit that could
not be produced at all is `failed`.

## Spend where the points are

Requirement extraction is worth 20 points — use the better model there. Link ranking is worth
nothing on its own and uses no model at all.

Truncate cleaned page text to a hard character cap before it reaches any prompt. TPM blowups
come from dumping whole sites into context, not from long instructions.

## Prompt injection

Every fetched page and every pasted JD is text you did not write. Structured delimiting plus
schema-constrained output. Say plainly in the README that this mitigates rather than solves it.

## Trace attributes

Every call emits a child span with:

```
model, prompt_hash, cache_hit, input_tokens, output_tokens,
attempt, queued_ms, rate_limited, repair_attempted
```

`cache_hit` and `queued_ms` are the two you will stare at while tuning.

## FakeLlmProvider

Returns canned schema-valid JSON, records every call it received. This is what lets
extraction, generation, coverage and pipeline tests run with zero quota. Build it in the same
session as the real adapter, not later.

## Tests

- RPM bucket: with a fake clock, 15 calls in a minute queue the 11th rather than firing it.
- TPM bucket: a large prompt is held when the token budget is short.
- 429 with `Retry-After: 5` waits ~5s, not the backoff default.
- Backoff is exponential with jitter and gives up after N attempts.
- Cache hit returns without touching the provider — assert the fake provider's call count is 0.
- Invalid JSON triggers exactly one repair attempt with the validation error included.
- Budget exhaustion surfaces as a typed error the pipeline can act on.

All with a fake clock. No real API calls in the test suite, ever.

## Done when

The limiter tests pass deterministically and `--fake-llm` produces a full pipeline run with
zero network calls.
