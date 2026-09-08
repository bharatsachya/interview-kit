# Decisions

Running log, written as each block lands. The README is assembled from this at H14 — the
rubric reads for judgment, so every non-obvious choice needs the reason recorded while the
reason is still fresh.

---

## H1 — foundation

### `packages/kernel` exists, beyond the package list in CLAUDE.md

`contracts` is interfaces and shared types only, so the `Tracer`, `Clock` and `IdGenerator`
implementations needed a home that was not `contracts` and not a domain package. All three
clear the bar for existing: each has a genuine second implementation — `NoopTracer` vs
`InMemoryTracer`, `SystemClock` vs `FixedClock`, `RandomIdGenerator` vs `SequentialIdGenerator`.
None is an interface invented for one implementation.

### The dependency rule is a compile error, not a convention

Three mechanisms, and all three are needed:

1. Each package's `tsconfig.json` declares `paths` for only the packages it may import.
   `contracts` has `"paths": {}` — it imports nothing, ever.
2. No package exposes `main` or `exports`. npm workspaces symlinks every `@trao/*` package
   into the root `node_modules`, so either field would let TypeScript resolve any package from
   any package and the allowlists would be decorative.
3. `npm run typecheck` runs tsc once per package against *its* config. The root
   `tsconfig.json` maps everything and is deliberately excluded — tsx and vitest need it to
   resolve everything at runtime.

Verified rather than assumed: with `node_modules/@trao/kernel` symlinked and present,
`import { NoopTracer } from "@trao/kernel"` inside `contracts` fails with TS2307.
`packages/contracts/test/dependency-rule.test.ts` guards mechanism 2, which is the one that
could silently rot — a `main` field added from habit would break enforcement without breaking
a build.

### Persistence interfaces are generic over the kit type

`KitStore<TKit = unknown>` rather than `KitStore` importing the kit type. `contracts` imports
nothing, and the kit document type lives in `packages/kit`. This is not a dodge: a store
persists and returns a document, it never interprets one. Only the composition roots pin the
parameter, as `KitStore<InternalKit>`.

### `OutputSchema<T>` is structural, so contracts needs no Zod dependency

```ts
safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } }
```

Zod schemas satisfy this as-is. The gateway still gets a real parse and a real error message
to feed back on the single JSON-repair retry, and `contracts` stays dependency-free.

### `Clock` carries `sleep()`, not just `now()`

The skill sketch had `now()` alone. `sleep` belongs on the same seam because H4's rate limiter
is the thing that most needs deterministic time: `FixedClock.sleep` advances virtual time and
resolves on the next microtask, so queueing, exponential backoff and `Retry-After` handling can
be asserted exactly, in milliseconds, instead of approximated with real timers. Sleepers wake
in wake-time order rather than call order, so a 5s waiter cannot overtake a 1s one.

Consequence, to be held to for the rest of the build: nothing in the repo calls `Date.now()`,
`new Date()`, `setTimeout` or `crypto.randomUUID` directly. It takes a `Clock` or an
`IdGenerator`.

### `SpanHandle.child(step, fn)` takes the function

The sketch had `child(step): SpanHandle`, which has no defined end — an unclosed child span can
leak into the trace. Passing the function in makes the lifetime explicit.

Parenting is also implicit, via `AsyncLocalStorage`: a `tracer.span()` call made anywhere inside
a running span becomes its child, so a step does not have to thread a handle down through every
helper it calls. That also parents concurrent siblings correctly, which a current-span stack
gets wrong the moment two fetches overlap — and `crawl_site` overlaps fetches by design.

Spans are recorded at start and mutated at end, so `export()` returns them in start order.
End order reads backwards: the innermost step appears before the step that called it.

### Not a build step

Packages are consumed from source through tsconfig `paths`, run by tsx and vitest. No
per-package compile, no project references, no `dist/` to stale. `npm run build` is currently
`npm run typecheck`; the API bundle is added at H14 when there is something to deploy.

---

## H2 — kit structure and state

### Appendix A is reconstructed, and quarantined in one file

The assessment brief was not available while this was built. Every Appendix A field name
appears in `packages/kit/src/appendix-a.ts` and nowhere else, each tagged `[SPEC]` (quoted by
the assessment or the skills, certain) or `[INFERRED]` (reconstructed from the prose). Internal
state is camelCase and the output is snake_case, so `toKitJSON` has to map every field by hand
— which means a wrong name is a one-file correction, not a search-and-replace across a repo.

Inferred, and worth ten seconds against the real appendix before submission: the top-level keys
`role` and `company_brief`, the sub-fields of both, `id` on the kit and on flashcards, and `day`
on a schedule day. Everything else is quoted. The skill permits extension but not renaming, so
the additions (`gaps` on the brief, `id` on flashcards) are safe either way.

### `toKitJSON` constructs every field by hand

Not a spread with a delete-list. A passthrough is how `pinned: true` eventually ships to a
grader — one new internal field, one forgotten line in the delete-list. With explicit
construction a field that is not named in the projection cannot leak, and the schema is
`.strict()` so anything that did leak fails validation loudly rather than shipping.

### Repair lives in `kit`, not in `scheduling`

Skill 02 puts repair at the serialize boundary, skill 03 lists it under scheduling. They cannot
both own it — `kit` importing `scheduling` would be a cycle, since scheduling produces
kit-shaped data.

It belongs in `kit`, and the reason is not just the cycle: **repair is not re-allocation**.
Re-running allocation would recompute day focus and reshuffle questions, wiping exactly the days
a user edited — the thing the `edited` flag exists to prevent. Repair does the minimum that
restores integrity: drop dead and archived ids, drop a duplicate when a question sits on two
days, place active questions that are on no day, recompute each day's minutes. It must not know
the allocation policy, and both projections in this package have to call it.

Placement rule for an orphan: the lightest day, earliest day breaking a tie, avoiding days the
user edited while any unedited day exists. If every day is edited it still gets placed — an
unscheduled question is worse than a slightly disturbed day.

### The minutes table lives in `kit` too

A day's `minutes` is an Appendix A field derived from another Appendix A field (`difficulty`) on
the same document. Allocation (H3) and repair both need it, and one shared table is the only way
the two can never disagree about what a day is worth. `scheduling` imports it from here.

### Editing does not pin

`editQuestion` promotes `generated` and `fallback` to `edited`; `manual` stays `manual`. It
deliberately does not set `pinned`. Conflating the two would silently opt a user out of ever
regenerating their own edits away, and the skill is explicit that "I changed this" and "keep
this" are different intents.

Flashcards follow their source question through a regeneration or an archive — but only while
they are still `generated` and unpinned. A card the user rewrote outlives the question it came
from.

### Two extra integrity rules beyond the mandated ones

The schema also rejects a question scheduled on two days (it would double-count minutes and read
as a duplicate to the user), and rejects unknown fields via `.strict()` (which is what makes the
no-provenance-leak guarantee enforced rather than asserted).

---

## H3 — scheduling and coverage

### 60-day policy: spaced review days

With 24 questions and 60 days, thin days leave ~36 days empty, and an empty day reads as broken
however valid it is — the skill is explicit that no day may be structurally broken. Learning the
material in the first stretch and revisiting it afterwards is also what anyone would actually
advise with two months to prepare.

Consequence, applied back to H2: the kit schema had rejected a question scheduled on two days.
Spaced review requires exactly that, so the rule was narrowed to reject a repeat **within one
day** (which double-counts minutes and reads as a bug) while allowing repeats across days.
Review days are labelled `Review — technical depth` and drawn from the same urgency-sorted list
with a rotating cursor, so every question is revisited before any is revisited twice.

### Allocation recomputes each day's share, rather than fixing one target

The obvious approach — target `total / days`, move on when a day exceeds it — is wrong with
chunky items, and visibly so. 480 minutes over 5 days sets a 96-minute target; every 30-minute
question overshoots immediately; days 1-4 take one question each and the entire remainder lands
on day 5. Twenty minutes a day, then two hours the night before: precisely the thing the brief
says not to do.

Recomputing `remaining / days left` as each day is filled self-corrects — a day that overshoots
lowers the share for the days after it, and the last day's share is by definition everything
left, so nothing is dropped. Distributions are now `[120, 90, 100, 90, 80]` over 5 days and
`[170, 170, 140]` over 3.

This was found by looking at the output, not by a failing test — the ten mandated tests all
passed against the broken allocator, because every one of them is about structure (day count,
integer minutes, must-have coverage, weight ordering) and none about *volume*. Two regression
tests now cover it: the last day is never the heaviest, and no day exceeds twice the average.
Neither asserts monotonically decreasing minutes, because front-loading is by weight and a day
of three medium questions legitimately out-minutes a day of two hard ones.

### Coverage takes a `GapFillWriter` function, not an `LlmProvider`

Skill 08's trace shows `coverage_check pass=1` and `gap_fill r3` as spans, which suggests
passing a `Tracer` in — but `NoopTracer` lives in `kernel`, and coverage may only import
`contracts` and `kit`. Rather than weaken the dependency rule for a default argument, coverage
stays pure and returns a per-pass report; the pipeline turns that into spans at H7.

The same reasoning applies to the model itself. Gap fill receives a narrow
`(cluster) => Promise<draft>` function, so the package cannot call a provider even by accident
and its tests need no fake provider — which is what let coverage be built before H4 rather than
after it.

### The writer is never asked which requirement it covered

The whole trust problem in one line. If the model returns a question tagged
`requirement_ids: ["r7"]`, a set difference sees r7 covered even when the question is about
something else — the model mislabels, the checker believes it, and the kit ships a fake pass.

So `GapFillRequest` has no field for requirement ids, and `GapFillDraft`'s optional
`requirementIds` is only ever *checked*, never used for labelling: an id we did not supply
rejects the draft outright. The code attaches the ids, because the code chose the cluster.

### Two loop guards that interact

"A pass closing zero gaps stops immediately" and "at most N attempts per requirement" are both
budget guards, and the first fires first when there is only one uncovered requirement — so the
attempts cap never gets a chance in that case. It earns its place when several requirements are
outstanding and some keep succeeding: the loop stays alive, and without the cap one stubborn
requirement would be retried on every remaining pass. Both are tested for what they actually
guard.

### Fallback questions invent nothing

Every content word comes from the requirement text or the role title; the rest is fixed
template, exported so the test can subtract the boilerplate and assert what remains came from
the input. A requirement too thin to slot into a sentence ("Go") falls back to the role title.
The answer outline is left empty rather than guessed — an invented outline is the one part of a
kit a candidate could not tell was made up.

---

## H4 — the LLM gateway

### Two seams, not one

`LlmProvider` in contracts is what the rest of the repo sees: prompt and schema in, parsed
object out. `ModelTransport` is internal to `packages/llm`: raw text in, raw text out, no
retrying, no caching, no parsing. Everything interesting lives in the gateway between them, so
there is one place to reason about rate limits and one place to test them. The transport
interface never leaves the package.

### Budget is reserved before the call, not charged after it

The obvious order — call, then charge actual usage — has a bug worth naming: if the actual
usage tips the run over its limit, `spend()` throws and the response is discarded *after* the
quota was already spent. Both the answer and the quota are lost.

So the gateway reserves `promptTokens + outputAllowance` before sending, and never charges
afterwards. Over-reserving errs towards stopping early, which is the safe direction when the
daily request cap is the scarce resource. A repair round reserves again, because it is a second
real request.

### Rate limiting is a queue, not a rejection

The RPM and TPM buckets serialise acquisitions through a promise chain. Without that, two
concurrent callers both read `available`, both decide there is room, and both spend it —
producing exactly the 429 the bucket exists to prevent. Batch mode runs two or three cases
concurrently against one shared quota, so this is a real path, not a theoretical one.

Measured against the actual batch budget: 40 calls (5 cases × 8) at 10 RPM completes in
**3.0 minutes** of queueing, inside a 15-minute window. At 15 RPM it is 1.7.

### Jitter, and why it is not decoration

`random()` is injected rather than called from `Math.random`, for the same reason `Clock` is —
the backoff tests assert exact numbers. Full jitter (uniform over `[0, ceiling]`) rather than a
fixed schedule because concurrent cases share one quota: undithered backoff would have them all
sleep the same interval and retry in the same instant, reproducing the burst that caused the
429.

`Retry-After` always wins when the provider sends it. It is the only party that knows when the
window actually reopens, and guessing shorter just burns another request.

### Local JSON repair before paid repair

Models wrap JSON in prose or code fences far more often than they emit genuinely malformed
JSON. `extractJson` strips fences and surrounding prose first, for free. Only a response that
survives that and still fails the schema costs a repair call — exactly one, with the validation
error fed back. A second repair on the same quota would be optimism rather than engineering.

The repaired result is cached under the **original** prompt hash, so an identical later request
skips the mistake entirely instead of repeating and re-correcting it.

### Two fakes, deliberately

`FakeLlmProvider` implements `LlmProvider` and bypasses the gateway entirely — `--fake-llm`
wants a full pipeline run in under a second, and there is nothing to rate-limit when nothing
leaves the process. `FakeTransport` sits underneath the gateway and scripts responses and
errors, so limiter behaviour is exercised without slowing the pipeline tests down.

`FakeLlmProvider` validates its own canned response against the caller's schema and throws if
it does not fit. A fixture that has drifted should fail loudly in a fast test, not quietly at
H8 against a real provider.

### The tracer is required here, unlike in coverage

Coverage returns a report and takes no `Tracer`, because its per-pass detail can be reconstructed
afterwards. The gateway's cannot: `cache_hit` and `queued_ms` are per-call and are the two
attributes you actually stare at while tuning. Making the `Tracer` a required constructor
argument means the trace can never be accidentally lost. Tests use a small `RecordingTracer`
local to the package, since `kernel` is out of reach.

### Prompt injection: mitigated, not solved

`untrustedBlock` wraps every fetched page and pasted description in delimiters that declare the
content to be data, and neutralises a payload's attempt to close the fence early. Combined with
schema-constrained output this raises the cost of an attack; it does not eliminate it. The
README says so plainly rather than claiming a fix.

### Open, still to decide

- Whether to build the creative feature at all — shares 10 points with practice mode.
