# @trao/pipeline

The nine steps, in order, each inside a span.

**The one package that imports every domain package**, because sequencing them is its job. It
still constructs nothing: providers, stores and clocks arrive as arguments.

## The nine steps

| # | Step | Model? |
|---|---|---|
| 1 | `extract_requirements` | yes |
| 2 | `fetch_homepage` | no |
| 3 | `crawl_site` | **no** — link ranking is a scoring function |
| 4 | `search_discussion` | no |
| 5 | `generate_brief` | yes |
| 6 | `generate_questions` | yes — four separate calls |
| 7 | `coverage_check` | **no** — a set difference |
| 8 | `gap_fill` (loops to 7, max 2 extra passes) | yes, for text only |
| 9 | `derive_flashcards` + `allocate_schedule` | **no** — arithmetic |

## The order carries meaning

A kit has to come from a sequence of deliberate steps that respond to what was actually found,
not one prompt returning everything. So: extraction runs first because the **company name it
finds** is what the discussion search looks for; the crawl runs before the brief because a brief
needs pages; and the **hiring-process text the crawl discovers is fed into question generation**,
so a company that publishes "take-home, then system design" produces a different kit from one
that says nothing.

## What the model is never allowed to decide

Schedule allocation, coverage gap detection, link ranking, and the requirement ids on gap-fill
questions. The first two are named in the brief; the second two are ours. This is the thing the
graders read for, and it is why steps 3, 7 and 9 have no provider anywhere near them.

## The degradation ladder

Every rung still produces a kit:

* Search key absent or the API down → no public-discussion section, recorded as a gap.
* An inner page 404s or times out → skipped and reported; the crawl continues.
* A question category fails → that section is thinner, the rest of the kit is unaffected.
* The model returns invalid JSON → one repair attempt inside the gateway, then the step is
  skipped and recorded.
* Budget exhausted mid-coverage → ship with the gaps listed rather than looping.
* Provider 429s → the gateway queues and waits. Only after retries are exhausted does a case
  become `failed`.

**A partial kit is `ok`; only a kit that could not be produced at all is `failed`.**

## `regenerateSection`

The same nine steps from the other end: rewriting one section of a kit somebody has been editing.
Three branches, one shared rule — *a regeneration may only take back what the machine put there
and the user has not claimed.* It never goes back out to the network (no fetcher, no search
provider in `RegenerateDeps`): re-crawling on a button press spends a user's rate limit to read
pages that have not changed since this morning.

The spans mirror the first-generation pipeline, so a rewrite reads in the trace viewer like the
steps it replays.

## Tests

`test/pipeline.test.ts` (ordering, the degradation ladder, spans), `test/regenerate.test.ts`
(versioning, provenance, ids, instructions). `test/doubles.ts` holds the local `StubLlm` and
`TestTracer` — `pipeline` may import every domain package but **not** `llm`, because it must
never construct a provider.
