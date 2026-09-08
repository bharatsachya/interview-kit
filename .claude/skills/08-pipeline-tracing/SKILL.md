---
name: 08-pipeline-tracing
description: Wire the nine pipeline steps in order, thread the budget object and tracer through them, implement the degradation ladder, and build the headless dev runner script. Use this skill whenever working on packages/pipeline or scripts/dev.ts, sequencing the research and generation steps, deciding what happens when a step fails, running the agent end to end without the UI, debugging what the pipeline actually did, or printing a span tree. Trigger this whenever someone needs to test pipeline behaviour — running headless with fakes is always faster than clicking through the interface.
---

# Pipeline and tracing

Block H7. First full run happens here, with fakes, before a single real API call is spent.

## The nine steps

1. **extract_requirements** — LLM
2. **fetch_homepage** — HTTP
3. **crawl_site** — heuristic ranking, no LLM
4. **search_discussion** — Tavily, degrades to nothing-found
5. **generate_brief** — LLM, from 2–4 only
6. **generate_questions** — four separate calls, one per category
7. **coverage_check** — pure code
8. **gap_fill** — one requirement at a time, then back to 7. Max 2 extra passes
9. **derive_flashcards** (pure), then **allocate_schedule** (pure)

Then `serialize_kit` → `toKitJSON` → validate.

Steps 7 and 9 never touch the model. Step 3 doesn't either.

## Every step is wrapped

No exceptions — a step without a span is a blind spot.

```ts
const requirements = await tracer.span("extract_requirements", async (s) => {
  s.set("jd_chars", jd.length);
  const result = await extractRequirements(jd, { llm, tracer });
  s.set("requirement_count", result.length);
  s.set("must_count", result.filter(r => r.priority === "must").length);
  return result;
});
```

The trace is also **evidence**. The rubric grades "the company site is crawled, a hiring page
sought, public discussion searched, question categories generated separately, and coverage
genuinely checked" — a trace dump proves all five in the video without narrating over a black
box.

## Degradation ladder

Put this in the README verbatim. Every rung still produces a kit.

- Search key absent or API down → no public-discussion section, recorded as a gap in the brief.
- Company site 404s or times out → kit generates from the JD alone, `pages_used` empty, brief
  says so honestly.
- Model returns invalid JSON → one repair attempt, then skip that step and record it.
- Budget exhausted mid-coverage → ship with gaps listed rather than looping.
- Provider 429s → queue and wait. Only after retries exhaust does a case become `failed`.

**A partial kit is `ok`. Only a kit that could not be produced at all is `failed`.** A missing
hiring page is not a failure.

## Idempotency

Hash `(normalised JD + company_url + days)`. Same submission twice → return the existing kit,
or join the in-flight job. Generation is slow and expensive; never pay twice.

## Headless dev runner — scripts/dev.ts

```bash
npm run dev:kit -- --jd ./fixtures/senior-backend.txt \
                   --url https://gitlab.com --days 5 \
                   --trace-pretty --out ./tmp/kit.json
```

| Flag | Effect |
|---|---|
| `--jd <file\|-->` | JD from file or stdin |
| `--url`, `--days` | company URL, days available |
| `--trace-pretty` | print the span tree |
| `--trace <file>` | dump spans as JSON |
| `--no-cache` | bypass cache, prove a cold run works |
| `--fake-llm` | `FakeLlmProvider`, zero API calls |
| `--fake-fetch` | serve pages from `./fixtures/sites/` |
| `--out` | write the kit JSON |

**`--fake-llm --fake-fetch` together give a full run in under a second with zero quota.** Use
this constantly. It is the single biggest speed-up available in a one-day build.

Same composition root style as `evaluate.ts`, for one case. Both import the identical
pipeline — never a parallel implementation.

## Pretty trace output

```
▸ generate_kit                                  42.3s  ok
  ▸ extract_requirements                         3.1s  ok   jd_chars=4820 must=7 nice=4
  ▸ crawl_site                                   4.2s  ok   pages=6 skipped=2 robots_blocked=1
  ▸ search_discussion                            0.0s  skip no_key
  ▸ generate_questions                          18.4s  ok
    ▸ category:technical                         5.1s  ok   reqs=5 out=8
    ▸ category:behavioural                       4.4s  ok   reqs=3 out=5
  ▸ coverage_check pass=1                        0.0s  ok   musts=7 covered=5 gaps=[r3,r6]
  ▸ gap_fill r3                                  2.8s  ok   accepted
  ▸ coverage_check pass=2                        0.0s  ok   musts=7 covered=6 gaps=[r6]
  ▸ fallback_questions                           0.0s  ok   r6 template=technical
  ▸ allocate_schedule                            0.0s  ok   days=5/5 placed=19 minutes=330
```

That screenshot is most of the video's "research and generation steps, and the second pass
closing a coverage gap" requirement.

## Tests

- Full run with `FakeLlmProvider` + `FakeFetcher` produces a schema-valid kit.
- Sparse fixture → kit still produced, `pages_used` honest, brief not fabricated.
- Broken fixture → `status: "failed"` with `COMPANY_UNREACHABLE`, run continues.
- Budget exhaustion mid-coverage → kit still produced with gaps listed.
- Same JD + URL + days twice → idempotent, one kit.
- Every step emitted a span; `generate_questions` has four child spans.

## Done when

`npm run dev:kit -- --fake-llm --fake-fetch` produces a valid kit in under a second and prints
a complete span tree. Only then swap in the real providers.
