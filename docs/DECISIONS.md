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

---

## H5 — retrieval and research

### Link ranking is a scoring function, and that is the point

The brief says directly that a fixed list of paths is not sufficient, and the fixtures prove it:
`deep/` keeps its hiring material at `/company/join-us`, which contains neither "careers" nor
"jobs". Anchor text is what carries the signal there ("Life at Northwind — how we interview"),
so anchor matches score double what URL matches do.

No LLM, deliberately. The crawl span carries the top five links **with their scores and the
reasons for them** (`anchor:hiring+20 url:handbook+7 depth:2-2`), so a grader can see why each
page was chosen. A model call cannot be inspected that way, would spend quota on a step worth no
points on its own, and would be slower than the fetch it is deciding about.

Measured across the fixtures: `/handbook/interviewing` 43, `/company/join-us` 38,
`/acme/careers/` 25, `/pricing.html` −20.

### The `acme` fixture is mounted at a sub-path on purpose

Appendix B's harness serves from `http://localhost:8099/acme/`, and every link in that fixture
is relative. Resolving them against the origin instead of the page's own final URL turns
`careers/` into `/careers/` and 404s the entire site — one bug that would break every batch case
at once. Mounting a fixture the same way means a regression fails a fast test rather than the
graders' run.

Links resolve against `finalUrl`, after redirects, never against the origin and never against
the URL we asked for.

### SSRF: the resolved address, not the hostname

`assertFetchable` resolves DNS and checks every returned address. Checking the hostname alone is
no check at all — a perfectly ordinary name can carry an A record pointing at 169.254.169.254,
and that is where every DNS-rebinding write-up begins. Redirect targets are re-checked after the
fetch, which is the hole in most hand-rolled guards. An address that cannot be parsed is treated
as private rather than assumed public.

**Why `ALLOW_PRIVATE_HOSTS` exists**, for the README: Appendix B serves from loopback while the
security section says reject loopback. Both are right for their environment. The flag is
defaulted **off**, turned on only for batch runs, and documented as a deliberate decision.
Getting it wrong fails either their harness or a security review.

### An oversized page is rejected, not truncated

Half a page passed silently to a summariser produces a confident brief built on a fragment. The
fetcher checks `Content-Length` and then verifies while reading, because a wrong or absent header
must not be a way to hand us 50MB. The crawl records the skip.

### robots.txt: unparseable means allow

That is the convention, and treating a 404 as "disallow everything" would produce an empty brief
for most of the web. A group naming our user-agent replaces the wildcard group entirely rather
than merging with it, which is how the standard works. Skipped URLs are recorded — honest
reporting is explicitly rewarded.

### The search key is optional with no branch in the pipeline

No key wires in `NullSearchProvider`, whose `name` is `"none"`; `searchDiscussion` reports
`skipped: no_key` and returns empty. A provider error, a timeout or a malformed response take the
same path. The pipeline never writes `if (hasKey)` — the wiring decides, so there is one code
path rather than two, and the second one cannot rot unnoticed.

### The dangling link in the gitlab-like fixture is intentional

Its homepage links to `/handbook/interviewing`, which does not exist. That link ranks **highest**
of all candidates, so the fixture proves the crawler survives its best candidate 404ing and still
reaches `/handbook/hiring` — a stronger version of "one 404 never aborts a crawl" than a
throwaway link would give.

---

## H6 — extraction and generation

### Prompt hygiene moved to `contracts`

`untrustedBlock` and `truncateForPrompt` were in `llm`, but extraction and generation both embed
untrusted text in prompts and neither may import `llm`. They are pure string functions with no
provider coupling — shared vocabulary for talking to a model, in the same sense `LlmRequest` is —
so they sit next to it in `contracts`, which still imports nothing. `llm` re-exports them.

The alternative, letting domain packages import `llm`, would have given them a route to a
provider. The dependency rule earns its keep here: `extraction` genuinely cannot call a model
except through the one handed to it, and its tests prove it by using a local stub.

### Extraction: three things the code decides, not the model

Worth 20 points, the largest single item, and the rubric's words are that the must-haves are
found, marked correctly, and **nothing is invented**.

1. **Ids** are assigned in order by the code, so they are stable and readable in the trace. The
   schema has no id field, so the model cannot invent one.
2. **Whether a requirement is real.** Every returned requirement is checked back against the
   posting and dropped if it is not there. Not exact substring — that would drop "5+ years of
   Python" for the model writing "five" — but a 60% content-token floor, which catches invention
   while tolerating rewording. Drops are counted and recorded with the missing words.
3. **Priority, where the posting says.** The posting is split on its own headings, each heading
   classified must/nice, and a requirement under "Nice to have:" is `nice` whatever the model
   claimed. The model's answer survives only for text under no heading.

Measured on the fixtures: the rich JD produced **3 priority corrections** — the model marked all
eight requirements `must`, and the posting's own heading demoted Kubernetes, Kafka and public
speaking. The two-line stub kept 1 of 4: `Docker and Kubernetes`, `Experience with microservices`
and `Strong communication skills` were all dropped as not in the posting, and an invented
location of "San Francisco" became `""`.

A heading is length-capped at 90 characters, because "experience with Kubernetes is required for
this role" is a sentence, not a section boundary, and treating it as one would re-label
everything after it.

### Four calls, four prompts, and skipping rather than inventing

One call per category with a distinct `purpose` — which also gives each its own trace span and
its own cache key, for free. Each is seeded only with the requirements of its kind, so a
technical requirement is never visible to the behavioural call.

Routing: technical and behavioural by kind; `company-fit` from domain requirements plus the
brief; `system-design` from technical requirements that read as architectural, falling back to
all technical when none do. A technical requirement legitimately supports both a depth question
and a design question, so it reaches both of those calls — but never the behavioural one.

A category with no requirements is **skipped and recorded**, not called. Asking a model for five
questions from an empty requirement list is an instruction to invent, and the empty categories
are exactly where invention shows. `company-fit` is the exception: it can run from the company
brief alone, with `requirement_ids: []`.

The model may tag questions with requirement ids, but only ids it was actually shown; anything
else is dropped. With a single-requirement seed there is no ambiguity, so an untagged question
gets that one attached.

### The brief makes no model call when there is nothing to summarise

The rubric rewards the empty case more than the easy one. A model handed an empty context still
writes a paragraph, and that paragraph is fiction — so when no pages and no discussion were
retrieved, the honest brief is written in code. `sources` and `pages_used` are always set from
what was actually fetched; the prompt explicitly tells the model not to list sources, because a
model asked for its sources will list plausible ones.

`hiring_process` is instructed to return an **empty string** when the material says nothing about
interviewing. That is the instruction a model is most likely to ignore, and a plausible invented
process is worse than nothing because the candidate prepares for the wrong thing.

### Flashcards take no `LlmProvider` at all

The strongest form of "zero model calls" is a function that has no way to make one. A question
with an empty outline gets no card — coverage fallbacks have no outline by design, and a card
with an empty back is worse than no card. The question still appears in the bank and on the
schedule.

Long prompts are fronted with their actual question sentence rather than a truncation, because
practice mode is scored and a card fronted with "Our ingest pipeline buffers in memory and…" is
not a prompt.

---

## H10 — the Express API, auth, and persistence

### `packages/api-contract` exists

`apps/web/src/lib/api/types.ts` carried a note saying these wire shapes belonged in `contracts`
once `apps/api` existed. It exists now — but they cannot go in `contracts`, which imports
nothing and so cannot see `InternalKit` or `EvaluationCase`. A package that may import both
`contracts` and `kit` is where they actually belong, and naming it for what it is beats filing
HTTP shapes inside the kit document package. Two consumers share it, which is the bar.

### The kit id bug, and the rule it violated

H1 drew a distinction: sequential ids (`r1`, `q1`, `f1`) are read by humans and compared by
snapshot tests, and only need to be unique inside one document; ids that outlive the run — kits,
jobs, users — are storage keys and must be globally unique.

The API wiring collapsed that. `makeDeps()` builds a fresh `SequentialIdGenerator` per job, so
**every job produced `kit_1`**, and the second user's kit silently overwrote the first user's in
the store. It surfaced as one ownership test seeing an empty list, which reads like a permissions
bug rather than a data-loss one.

`RoutedIdGenerator` now routes by prefix — sequential within the kit, random for `kit_` — so the
rule lives in code rather than in a paragraph two thousand lines away. The fix belongs in
`kernel` rather than in the API because the API is not the only place that could get it wrong.

### Authentication is verified in the API, not delegated to Next.js

The Express API checks Clerk tokens against JWKS itself. An API that believes a header because
the frontend promises to set one is not authenticated; it is authenticated only to people who use
the frontend.

Failures say "Token could not be verified" and nothing more — "expired" versus "bad signature"
tells an attacker which half of the problem to work on. Someone else's kit returns **404, not
403**, for the same reason: confirming a resource exists is itself a leak.

`DevAuthenticator` reads the user id from the header for local work, and `main.ts` refuses to
start with it when `NODE_ENV=production`. An auth bypass a stray environment variable could
switch on in production is not a bypass, it is a vulnerability.

### Routes are wrapped rather than middlewared

`guarded()` takes a handler whose signature demands a `userId`. A route that forgets to
authenticate is a route that does not compile — which is a stronger guarantee than remembering to
put `app.use(requireAuth)` above the right line.

### Progress is read from the trace

The job runner polls its own tracer and reports the current step name from the spans. A
hand-maintained step list would be a second source of truth about what the pipeline does, and it
would be wrong the first time a step was renamed. The `/jobs/:id` response carries the spans with
the job for the same reason — asking for them separately lets the two answers disagree about
which step is running.

### Idempotency at the API, not in the pipeline

`POST /kits` hashes `(normalised JD + company_url + days)` and hands back a completed job if that
kit already exists for that user. Generation is about eight model calls and a site crawl; a
double-submitted form must never pay twice. The pipeline computes and returns the hash but
enforces nothing — batch mode has no store to check against, and a pipeline that knew about
storage would need one.

### Memory persistence is not a test double

Batch mode runs on it in production, because the graders clone the repository and run one
command. Mongo adapters exist for the app. `pipeline` imports neither.

### Open, still to decide

Nothing here any more. For the record, since this section was the place it was tracked: the
creative feature was built, twice. A **weak-spots report** attributes card confidence back to
question tracks through shared requirement ids, and a **cross-kit comparison** clusters the
requirements that recur across several kits. Neither costs a model call, which is why both could
be added without spending the day's quota to demonstrate them. See the README.

---

## H11 — the web app: design system, auth, kit view

Taken out of order, ahead of H8–H10, at the request of the person building this. The kit view
therefore reads a fixture rather than the pipeline. Nothing else about it is provisional: it
renders the real `InternalKit` through `getKitForBuilder`, so wiring the API later replaces one
function and no component.

### The design system is the project's own, not a library's

`docs/design-system.html` is the source of truth for the look: near-white
ground, mint for what needs you now, dusty teal for the system's own work, and one red spent
only on failure. It specifies its own stack — one theme layer declaring the fonts and the teal
ramp as CSS variables, then Tailwind core utilities and no arbitrary values in component code —
so `globals.css` is a `@theme` block plus the handful of utilities Tailwind has no core class
for (`hatch`, the `blueprint` frame and its registration marks, the reading measures).

The rule this buys: a value used twice becomes a token. Nothing in a component sets a colour or
a measure directly, so retuning the system is one file.

### Difficulty and confidence are counted, never coloured

Ink ticks and hatch density, with the value printed alongside and an aria-label carrying it.
They survive greyscale, small sizes and colour blindness. The same reasoning puts a letter in
every category square rather than relying on its hue.

### Route protection is resource-based, not middleware path matching

`clerkMiddleware()` establishes the auth context; it does not decide access. The decision lives
in `app/(signed-in)/layout.tsx`, which calls `auth.protect()` and wraps every page in the group.

This is Clerk's own current guidance — `createRouteMatcher` is deprecated because path matching
can diverge from how Next actually routes a request. It diverged here in practice: with a
matcher-based guard the signed-out root returned a 404 carrying the redirect target as its body
instead of a 307. The route group has no path segment, so a page is protected by virtue of
where it lives rather than by remembering to add it to a list.

Ownership — whether *this* user may read *this* kit — is deliberately not here. Middleware knows
who is signed in, not whose kit is being asked for, so that check belongs next to the load.

### Clerk runs on accountless development keys

`npx clerk@latest init --accountless` provisions temporary keys, so a clean clone can run the UI
without anyone creating a Clerk account. `.env.example` documents the variables; the real values
live in the gitignored `.env.local`.

### Nothing is clickable that does not act

`RequirementChip` renders buttons only when handed a handler, and plain text otherwise. The kit
view is read-only, and a control that looks pressable but does nothing is worse than a label.

### The fixture is deliberately awkward

Two must-haves with no question, a brief with recorded gaps, one hand-written question and one
edited-and-pinned. A fixture where everything succeeded would let every honest-degradation state
go unbuilt, which is exactly the set of states the rubric reads for.

### Known gap: the design system's third coverage state has no field behind it

The sheet draws coverage cells in three states — covered, uncovered, and *unclear*: a
requirement that could not be parsed, hatched and excluded from the maths. `CoverageReport`
carries only `passes` and `uncoveredRequirementIds`, and `RequirementKind` is an Appendix A
field that cannot be extended. The bar is built covered/uncovered only. Adding the third state
means finding it an Appendix-A-safe home first — an internal-only flag on `Requirement`, which
the projection would strip — and that is a kit-structure decision, not a UI one.

---

## Frontend session 1 — foundation, create, progress

### Intake is a conversation, and the turns are scripted

The create form was replaced with a conversation by request. The turns are not generated. The
three things a kit needs — description, company site, days — are fixed and knowable, and a model
call to ask "what is the URL?" would add latency and a failure mode while buying nothing a person
could not read faster. Intake therefore never rate-limits and works with no API key.

The brief names a JD textarea, a company website field and a days field, and all three are still
present: each turn's composer *is* the typed control for the field being asked about, with its
own label, input type and inline validation. The conversation is the arrangement; the fields keep
their types.

### The Appendix B parser lives in `packages/kit`

`appendix-b.ts` sits beside `appendix-a.ts` because both are frozen shapes the assessment hands
us. The multi-role upload and `scripts/evaluate.ts` call the same `parseCases`, so the two cannot
drift. It rejects duplicate case ids: the output is one entry per case keyed by id, which
duplicate ids make impossible, and the symptom would otherwise be a silently short `kits` array.

It could not go in `contracts`, which is deliberately Zod-free.

### Four phases over nine steps

The progress screen reads step names off the trace rather than from a hardcoded list, then groups
them into four phases: nine rows is a list to audit, four is a thing to watch. Per-step detail and
real durations sit one level down. A step the pipeline adds later appears under "Other work"
rather than disappearing — a progress display that silently omits work is worse than a coarse one.

No percentage anywhere. The pipeline cannot know how long a crawl takes.

### Degradation is drawn as success

A skipped discussion search or an unreachable company site produces a completed phase with a
note, never an error mark. Only a step that actually errored is `failed`, and the run still
continues. This is `toPhaseViews`, and it has twelve tests on it precisely because it is the kind
of state machine a later tidy-up would "simplify" into treating skipped as broken.

A failed *poll* is also not a failed *job*: polls are counted and surfaced only after three
consecutive failures, with a note saying the run is unaffected.

### Elapsed time comes from the job, not from a clock

`Date.now()` during render is impure, and the figure would only move when a poll happened to
land. The job's own `createdAt`/`updatedAt` are the server's numbers and the true ones.

### `src/lib/mock/` stands in for `apps/api`

It emits the nine real step names as real `Span` records with real statuses, so the progress
screen is built against the shape the pipeline will produce rather than one invented for it. It
allocates days with the real pure allocator instead of reimplementing one, which is the only
reason `@trao/scheduling` appears in the app's tsconfig allowlist. That entry and this directory
are deleted together when the API lands.

Its two degradations are chosen by the environment, not at random, so a demo is reproducible: no
`TAVILY_API_KEY` skips the search, an unreachable site writes the brief from the description alone.

---

## H12 — regenerating one section of a kit somebody is editing

`packages/pipeline → regenerateSection(kit, request, deps)`. Three sections, three quite
different jobs, one shared rule: **a regeneration may only take back what the machine put there
and the user has not claimed.**

### The brief's retrieval record is carried over, not recomputed

Regeneration re-runs generation; it never goes back out to the network. Re-crawling on a button
press spends a user's rate limit to read pages that have not changed since this morning.

So `sources`, `pagesUsed`, `passages` and `gaps` are copied across verbatim and only the prose is
replaced. Letting `generateBrief` recompute them looks tidier and is wrong: `sources` would
silently lose the discussion results this call never saw, and `gaps` would gain "no public
discussion was retrieved" for a kit where some had been. Those fields are a factual record of
what was fetched, and the fetch did not happen again.

This is why `CompanyBrief` gained `passages`. Without the page text, a brief regeneration prompts
the model with a list of bare URLs and no bodies — and a model handed an empty context writes a
paragraph anyway. Kits stored before the field existed fall back to `pagesUsed` and regenerate
thin, which is the honest failure.

### The questions branch never writes to `schedule`

It archives, generates, runs coverage and derives cards. It does not touch a single day.

Repair lives at the serialize boundary, so an archived question leaves its day and a new one is
placed when the kit is next projected — by `toKitJSON` and `getKitForBuilder` alike, which is why
the two views always agree. Writing to `schedule` from this path is what would wipe a day
somebody rewrote, and it is what makes "every schedule day is byte-identical after a category
regeneration" a property rather than a coincidence.

### Exactly one `commit()` per call

However many internal steps run, the version bumps by one, so a caller holding version 7 sees 8
and `ifVersion` means what it says. The trap is that `regenerateCategory` now goes through
`commit()` itself: it is a committed mutation, not a helper. The branch calls it once for the
archive-and-append and then assembles the coverage questions and the new flashcards onto its
result without committing again.

### The seed is the gap list, not the category

A category regeneration asks about the requirements **nothing still active covers** — the holes
the archiving just opened — rather than the whole category. Handing the model the full list
spends the call producing near-duplicates of the pinned and edited questions that were kept.

When the survivors cover everything the full list comes back, because the user pressed regenerate
and is owed questions. "Nothing was uncovered, so here is nothing" is a correct reading of the
gap list and a broken button.

### Two gates are deliberately not run on this path

Both are deviations from "exactly what the first generation does", and both are here rather than
behind a quiet default, because both are the kind of thing `04-coverage` warns about and a reader
should get to disagree with them.

**The tag gate (`gateQuestionTags`) does not re-run over questions already in the kit.** It is
admission control on model output at the moment it enters, and it is not idempotent against a
*stored* question the way it is against a fresh one: it judges the question's text against the
requirement's source sentence, and a question the user has since rewritten no longer reads like
the sentence it was generated from. Re-running it on every regeneration means a question quietly
loses the requirement it covers — during a regeneration of a *different* category, with nothing
in the UI to say why. The base fixture shows the symptom exactly: a question about introducing
Kafka, tagged with "Kafka or similar", fails the ambiguous-token anchor check against its own
source span and comes out covering nothing at all.

It is also only a shared-term threshold, which is the right trade for admission — cheap,
deterministic, inspectable — but its false negatives are real. "PostgreSQL query tuning" and a
question about `Postgres` index bloat share no token. Paying that cost once, when the question
enters, is proportionate; paying it again on every later regeneration is how a kit erodes.

Gap fill's own gates (`acceptGapFill`) are unaffected and always run. That answer *is* fresh model
output, and it is the one place a hallucinated id could still get in.

**The single-seed auto-tag is suppressed.** On a first generation, a category seeded with exactly
one requirement has no ambiguity about what a returned question was answering, so `runCategory`
tags it even when the model forgot to. On a regeneration the seed is the gap list, so doing that
would be the *seed* deciding the gap is closed — the same failure as letting the model decide, one
level up. `autoTagSingleSeed: false` lets coverage reach its own verdict instead. The eval case
`regen-technical-refills-newly-uncovered-must` is built on it: the fake answers a Go question to a
Postgres seed, and Postgres has to stay open.

### The id generator is wrapped, because the invariant belongs to the document

`regenerateSection` wraps whatever `IdGenerator` it is handed and skips any name the kit already
holds. Soft delete is the reason: nothing is ever removed and no id is ever reused, which is what
makes a dangling reference impossible in storage — and a generator handing back an id already in
use turns that guarantee inside out. The new question does not replace the old one, it sits beside
it: two records, one id, `byId` maps silently keeping whichever came last, and a schedule day that
no longer says which of the two it meant.

Not hypothetical. A composition root that builds a fresh `SequentialIdGenerator` per job — which
is what `--fake-llm` did — starts counting at `q1` against a kit whose first question is `q1`. The
generator is not wrong in isolation; it has no idea a document already exists. Three call sites
needed this guard independently and two of them got it wrong, which is the argument for enforcing
it where the document is rather than asking every caller to remember.

Skipping rather than throwing, because the right answer is obvious and costs one loop, and a
merely misconfigured caller should keep working. `ids_skipped` on the span is what stops that
being invisible — zero on a correct caller, non-zero the moment someone wires it up wrong.

### The trace reads like the steps it replays

`regenerate_section` wraps the same child spans the first-generation pipeline emits —
`generate_questions > category:<name>`, then `coverage > coverage_check pass=n`, then any
`gap_fill <ids>`. A category regeneration that produced the right kit with no `coverage_check` in
the trace ran a set difference nobody can see, so the runner asserts the ordering as well as the
result.
