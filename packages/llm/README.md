# @trao/llm

The single gateway to a model provider, and the fakes that make the rest of the build possible
without an API key.

Imports `@trao/contracts` only. **Nothing outside this package may call a provider** — one place
to reason about rate limits, retries, caching and malformed output, and one place to test them.

## The gateway

`LlmGateway` implements `LlmProvider`. Every model call in the system goes through it:

* **RPM and TPM token buckets** with a request queue, so four concurrent question calls do not
  leave at once.
* **Exponential backoff with jitter**, honouring `Retry-After` when the provider sends one.
* **A response cache** keyed on a hash of the prompt (`promptHash`), so a repeated run costs
  nothing. `MemoryCacheStore` and `NullCacheStore` ship here.
* **One JSON repair attempt** (`extractJson`) before a step is given up on. Models wrap JSON in
  prose and fences more often than they emit invalid JSON.
* **A prompt ceiling** (`DEFAULT_MAX_PROMPT_TOKENS`, 32,000) — a bug detector, not a cost
  control. Every real prompt is bounded small already; this sits three times above the largest
  one and catches a truncation that stopped truncating, which would otherwise surface as a
  provider 400 at whichever context limit the fallback chain reached. `prompt_chars` and
  `input_tokens` go on every span either way, so the headroom is a fact rather than an assumption.
  Checked *before* the cache: a stored answer would hide the bug until the day it missed.
* **A run budget** (`RunBudget`) — the gateway stops retrying at the run's deadline rather than
  letting one slow step eat the whole job.

## Three transports, one model list

`GeminiTransport`, `ZaiTransport`, `OpenRouterTransport`, all behind `ModelTransport`.

`RoutedTransport` is what makes them a chain rather than a choice: the model list names
`provider:model` and each name is sent to the transport that understands it. No new mechanism was
needed — the gateway already walked a list and moved to the next name when one reported itself
unavailable, and a spent Gemini daily cap reports itself exactly that way.

Order is Gemini → Z.AI → OpenRouter. `LLM_PROVIDER` pins one, or a comma list reorders them.

**The one provider-specific thing** is in `zai.ts`: every GLM model reasons before answering,
which is nine seconds versus forty-four against a thirty-second request budget, and the two model
families disagree about how to turn it down — `glm-4.x` takes `thinking: {type: "disabled"}` and
400s on nothing, `glm-5.3` 400s on exactly that and takes `reasoning_effort`. Both are sent, and
`thinking` is dropped for any model that has rejected it once, so the discovery costs one cheap
400 per model per process rather than a hardcoded list of names that would rot.

`http.ts` is the shared request/timeout/error handling Z.AI and OpenRouter both use.

## The fakes

`FakeLlmProvider` answers from a canned response table (`fixtures/fake-llm-responses.ts`) and
records every call. `FakeTransport` does the same one layer lower, so the gateway's own retry and
backoff behaviour can be tested. `rateLimited()` builds a responder that 429s on cue.

`--fake-llm` gives a full pipeline run in well under a second with zero quota. Everything up to
the API swap needs no key at all.

## Tests

`test/gateway.test.ts` (buckets, backoff, `Retry-After`, cache, repair, budget),
`test/units.test.ts`, `test/routed.test.ts`, `test/openrouter.test.ts`, `test/zai.test.ts`.
