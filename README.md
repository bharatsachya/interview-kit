# AI Interview Prep Kit

Paste a job description, a company URL and how many days you have. Get back a researched,
editable prep kit: a company brief, the role broken into requirements, a categorised question
bank, flashcards, and a day-by-day study schedule — all of it editable, and regenerable a
section at a time without losing the edits.

Built for the Trao Full-Stack Engineering Assessment (FS-AI-INTERVIEW-01).

```bash
npm ci
npm run evaluate -- --input fixtures/cases.json --output kits.json --fake-llm --fake-fetch
```

That runs the whole pipeline over five job descriptions in about a second, from a clean clone,
with **no API key, no database and no network**. It is the fastest way to see that this works.

---

## Contents

| | |
|---|---|
| [What it does](#what-it-does) | the nine steps, and what each is responsible for |
| [Running it](#running-it) | local setup, the batch command, the API and the web app |
| [Architecture](#architecture) | the one rule the whole repo is arranged around |
| [The builder](#the-builder-and-the-state-problem) | what is editable, how a rewrite forks, and how an edit survives a regeneration |
| [Scheduling](#scheduling) | why the schedule is arithmetic and not a prompt |
| [Coverage](#coverage) | gap detection, two extra passes, and the acceptance gates |
| [Retrieval](#retrieval) | crawling, link ranking, and what is actually read |
| [Robustness](#robustness-the-degradation-ladder) | the degradation ladder |
| [Security](#security) | SSRF, `ALLOW_PRIVATE_HOSTS`, and prompt injection |
| [Practice and the creative features](#practice-and-the-creative-features) | |
| [Testing](#testing) | unit tests and the step-by-step eval suite |
| [Trade-offs and known limitations](#trade-offs-and-known-limitations) | read this one |

Deeper material lives in [`docs/DECISIONS.md`](docs/DECISIONS.md) (every decision, with its
reasoning, in build order), [`docs/RUNNING.md`](docs/RUNNING.md) and
[`docs/DEPLOYING.md`](docs/DEPLOYING.md).

---

## What it does

Nine steps, in order, each wrapped in a trace span from the first line it was written:

| # | Step | Model? | Responsible for |
|---|---|---|---|
| 1 | `extract_requirements` | yes | The posting → requirements with `kind` and `must`/`nice`, plus the role summary |
| 2 | `fetch_homepage` | no | One fetch, with SSRF validation and a byte cap |
| 3 | `crawl_site` | no | Rank the links, follow the promising ones, obey robots.txt |
| 4 | `search_discussion` | no | Public discussion of how the company interviews (optional key) |
| 5 | `generate_brief` | yes | The company brief, from pages actually retrieved |
| 6 | `generate_questions` | yes ×4 | Technical, behavioural, system-design and company-fit — **four separate calls** |
| 7 | `coverage_check` | no | Which must-have requirements no question covers |
| 8 | `gap_fill` | yes | One question per uncovered requirement, then back to 7 |
| 9 | `derive_flashcards` + `allocate_schedule` | no | Cards from questions; days from arithmetic |

The order carries meaning. Extraction runs first because the company name it finds is what the
discussion search looks for. The crawl runs before the brief because a brief needs pages. The
hiring-process text the crawl discovers is fed into question generation, so a company that
publishes "take-home, then system design" produces a different kit from one that says nothing.

**Four things the model is never allowed to decide:** schedule allocation, coverage gap
detection, link ranking, and the requirement ids on gap-fill questions. The first two are named
in the brief. The second two are ours, for the same reason: each is a judgement that can be made
correctly in code, and a model that makes it can be wrong in a way nothing downstream detects.

---

## Running it

### Local

```bash
npm ci
cp .env.example .env          # everything in it is optional for the commands below
```

Nothing below needs a key or a database:

```bash
npm test                      # 734 tests
npm run typecheck             # 17 projects, each against its own dependency allowlist
# One kit, headless, with the span tree printed to stderr:
npm run dev:kit -- --jd fixtures/jds/senior-backend.txt --url https://meridian.test/ \
  --fake-llm --fake-fetch --trace-pretty
```

With a key (see [LLM provider](#llm-provider-and-model)), drop the `--fake-*` flags.

The web app and API together:

```bash
npm run dev                   # both, with fakes
npm run dev:real              # both, against real providers
```

Full detail, including how to read a trace and how to see the exact prompts sent to the model,
is in [`docs/RUNNING.md`](docs/RUNNING.md).

### The batch command

Frozen by the brief, and it is the entry point for the 55 automated points:

```bash
npm run evaluate -- --input <cases.json> --output <kits.json>
```

Output is Appendix B exactly: one entry per input case, keyed by the given id, each `ok` with a
kit or `failed` with a code. It runs on the **in-memory store with no user**, so a clean clone
and one command is genuinely all it takes — no database to stand up, no account to create.

Add `--fake-llm --fake-fetch` to run it with no key and no network at all.

### Deployed

The web app on Vercel, the API on Azure Container Apps, MongoDB Atlas, Clerk.
[`docs/DEPLOYING.md`](docs/DEPLOYING.md) is the runbook; the short version is
`cp .env.deploy.example .env.deploy && ./scripts/deploy-api.sh`, then point Vercel's
`API_ORIGIN` at what the script prints.

### LLM provider and model

**Gemini Flash** by default (`gemini-flash-latest`, falling back through `gemini-3.6-flash` and
`gemini-3.5-flash`), with `gemini-flash-lite-latest` for the cheaper calls. Requirement
extraction is the one step that asks for the `quality` tier; everything else takes `fast`.

**Z.AI (GLM)** and **OpenRouter** sit behind it as a fallback chain — Gemini → Z.AI →
OpenRouter. Not redundancy for its own sake: Gemini's free tier is a *daily cap* of roughly
twenty requests per model rather than a rate limit, so once it is spent, waiting does nothing.
The other two are metered separately, and measured against the same real extraction prompt
`glm-5.3-flash` answers in about four seconds against OpenRouter's twenty — so GLM is the middle
rung rather than a second floor.

It needed no new mechanism. The gateway already walked a model list and moved to the next name
when one reported itself unavailable, and a spent daily cap reports itself exactly that way; the
list simply names models from all three providers and `RoutedTransport` sends each
`provider:model` name to the transport that understands it. `LLM_PROVIDER` pins one provider, or
a comma list reorders them.

GLM needed one provider-specific thing, and it is the interesting part of `packages/llm/zai.ts`:
every GLM model reasons before answering, which is the difference between nine seconds and
forty-four against a thirty-second request budget, and the two model families disagree about how
to turn it down — `glm-4.x` takes `thinking: {type: "disabled"}` and 400s on nothing, `glm-5.3`
400s on exactly that and takes `reasoning_effort` instead. Both are sent, and the `thinking`
field is dropped for any model that has rejected it once, so the discovery costs one cheap 400
per model per process rather than a hardcoded list of model names that would rot.

Every model call in the system goes through one gateway (`packages/llm`) — RPM and TPM token
buckets, a request queue, exponential backoff with jitter, `Retry-After` handling, a response
cache, and one local JSON-repair attempt before a paid one. Nothing outside that package is
allowed to call a provider.

---

## Architecture

```
apps/          web (Next.js)  ·  api (Express — a composition root)
packages/      contracts · kernel · kit · llm · retrieval · research · extraction
               generation · coverage · scheduling · practice · persistence
               auth · api-contract · pipeline
scripts/       evaluate.ts · dev.ts · deploy-api.sh
evals/         the step-by-step eval suite
```

**Every package depends on `contracts` and nothing else horizontally.** Packages receive their
dependencies as arguments. Only `apps/api/src/main.ts`, `scripts/evaluate.ts` and
`scripts/dev.ts` construct an adapter.

This is enforced, not agreed: each package's `tsconfig.json` declares path mappings only for the
packages it may import, and no `@trao` package publishes a `main` or `exports` field, so npm's
workspace symlinks cannot route around the allowlist. `extraction` importing `llm` is a compile
error. `npm run typecheck` is what checks it.

Interfaces exist only where there is a real second implementation — memory vs Mongo, null vs
Tavily, fake vs real model, fake vs live fetcher. Domain logic is not abstracted.

**Auth is Clerk rather than hand-rolled.** The brief says to keep auth minimal and does not score
it, so the cheapest correct thing wins. The API still verifies every token itself against Clerk's
JWKS — it does not trust the Next.js side to have done it, because an API that believes a header
because the frontend promises to set one is authenticated only to people who use the frontend.

---

## The builder, and the state problem

Everything in a kit is editable: every question prompt and answer outline, every flashcard's two
sides, the brief, and any day's focus. Questions reorder within a category, move between
categories, and can be written by hand — as can flashcards, which are otherwise derived. Any
question, any card, and any of the brief, one question category or the schedule can be
regenerated on its own.

### Conversations

The workspace is organised around a **session**: one conversation holding the posting you sent,
every rewrite you asked for since, the runs they started and the kits they produced. The URL is
`?session=<id>` — it used to be `?kit=…&jobs=…,…,…`, which grew a job id on every rewrite.

There is **no `sessions` collection.** A session is `GROUP BY sessionId` over the jobs and kits
the API already reads on every page load, both already indexed by user. A fourth store would be a
fourth thing to keep in step, and its `turns` array would be a second source of truth about what
ran — disagreeing with the job records the first time a write half-succeeded. Grouping cannot
disagree with itself.

Kit ids and job ids do not go away and could not: a kit is a document the builder writes to at
`/kits/:id`, and a job is what the progress stream polls. The session is a grouping over them.

Two things follow, and the second is the one that mattered:

* **The history rail lists conversations, not documents.** A rewrite forks, so one piece of work
  can hold four kits alike in every field a row shows; the revisions nest under the conversation
  instead, each labelled with what its rewrite did.
* **The transcript survives a reload.** What you typed is stored on the job record as a
  discriminated `JobAsk` — a posting or a rewrite, in the words you sent it. It used to live in
  React state, so a refresh returned the runs and their traces and lost the asks, which is the
  half a transcript is for. Traces are still not persisted, so a conversation reopened tomorrow
  says what each turn did and declines to say how long it took rather than claiming zero seconds.

Batch mode has no session, for the same reason it has no user: no browser, no transcript, nobody
to show one to. `sessionId` is null there and the API layer attaches it, exactly like ownership —
`pipeline` and `npm run evaluate` never learn the field exists.

**Regenerating is a prompt, and it forks.** Pressing Regenerate in the kit panel does not call
anything. It writes a sentence into the composer in the main window — "Rewrite the technical
questions." — which the user can change before sending: *"…and go harder on replication"*. That
free text travels as `instructions`, reaches the generation prompt inside an untrusted fence, and
is allowed to change emphasis and difficulty and nothing else. The schedule accepts the field and
ignores it, because allocation is arithmetic in code, and the trace records
`instructions_ignored` rather than letting a dropped request look like an honoured one.

Sending it runs a job with an id, a trace and a progress line, exactly like a first generation —
and writes the result to a **new kit**. The kit you pressed the button on is not touched: same
id, same version, same questions, still in the history rail, which now shows the rewrite beside
it as `v2` labelled with what it did. Three things follow from that, and they are the reason it
is worth the extra document:

* **A rewrite is undoable by being un-done-to.** Several model calls replacing work you have been
  editing is not something to put one click away with no way back.
* **The "did the old one ask this better?" question has an answer.** Both kits are there, and the
  compare view already reads more than one.
* **There is nothing to race.** No `If-Match` on the rewrite, no conflict banner, no "your edit
  landed while the section was rebuilding" — the answer goes somewhere the edit is not.

The fork carries the whole document across with every id intact, so the schedule's question ids
and the practice deck's card ids still point at the same material. It starts its own `version` at
1 (two documents both claiming version 8 is how an `If-Match` against one passes against the
other) and gets a hash that cannot collide with a submission hash, so resubmitting the original
posting still finds the original kit rather than its third rewrite.

Which is where the hard part is. The 15-point item, and the one the brief says it will look at
most closely: *regenerating one section must not discard edits made elsewhere, and a question the
user wrote or edited by hand must survive a regeneration of its category.*

Every editable item carries four fields that never appear in the Appendix A output:

| Field | Meaning |
|---|---|
| `origin` | `generated` · `edited` · `manual` · `fallback` |
| `pinned` | the user asked for this to be kept |
| `active` | soft delete — false means gone from every projection |
| `order` | position within its category |

**The rule underneath every transition:** a regeneration may only take back what the machine put
there and the user has not claimed. So regenerating a category archives exactly the questions
that are `generated`, unpinned and in that category. Edited, manual, pinned and fallback
questions survive, as does every other section. Forking does not replace that rule, it sits on
top of it: what carries into the new kit is decided by provenance, exactly as it was when the
rewrite wrote in place.

`origin` and `pinned` are separate on purpose. "I changed this" and "keep this" are different
intents, and editing does not pin — conflating them would silently opt the user out of ever
regenerating their own edits away.

**Nothing is ever deleted and no id is ever reused.** Deletion is a flag, which is what makes a
dangling reference impossible in storage. The schedule is repaired at the *serialize* boundary,
inside both projections, rather than on the write path — so an archived question leaves its day
when the kit is next projected, and writing to `schedule` from a regeneration (which would wipe a
day the user rewrote) never has to happen.

Two projections, and both run repair, so the two views can never disagree:

* `getKitForBuilder(kit)` — active items, provenance intact. What the UI reads.
* `toKitJSON(kit)` — Appendix A, provenance stripped, validated. What batch output and export
  produce. Every field is constructed by hand rather than spread, so a field that is not named
  cannot leak.

Concurrency is a `version` on the kit, bumped by exactly one per mutation. Writes send it as
`If-Match`; a mismatch is a `409` carrying `current_version`, and the builder rebases rather than
reloading. The check lives inside the same function that does the bump, so a mutation that
checks and forgets to bump cannot be written. Rewrites are outside all of this by construction —
they never write to the kit they read, so there is nothing for a concurrent edit to conflict with.

---

## Scheduling

Pure arithmetic. Questions and a day count in, a schedule out — no model, no network, no clock.

1. Sort every active question by urgency: `difficulty × priority`, hardest and most important
   first.
2. Fill days in order up to a per-day minute target. Because the list is sorted, day 1
   necessarily gets heavier material than day 2 — hard work lands early, not the night before.
3. Anything left when the last day is reached goes on the last day. Nothing is ever dropped: a
   must-have that fell off the end would be a coverage failure caused by the scheduler.
4. Days still empty become **spaced review days**, cycling back through the material by urgency.

Minutes come from a fixed table — easy 10, medium 20, hard 30 — so every total is an integer.

**The 1-day case** puts everything on day one; that is what one day means. **The 60-day case**
is why step 4 exists: with 20 questions and 60 days, thin days leave 40 days empty, and an empty
day reads as broken however valid it is. Revisiting material after learning it is also what
anyone would actually advise with two months to prepare. Cross-day repeats are therefore legal
in the schema; a repeat within one day is not.

A day the user edits is flagged, and allocation steps around it forever after.

---

## Coverage

After generation, a set difference: which `must` requirements have no active question tagged to
them. That check is code, not a prompt — "did you cover everything?" is a question a model will
cheerfully answer yes to.

Uncovered must-haves go back to the model **one requirement per call**, and the caller assigns
the requirement id on the result. The writer is never asked which requirement it just covered,
because a model that can tag its own output can close a gap by relabelling instead of by
answering.

Then two acceptance gates. A gap-fill question is only accepted if it overlaps the requirement's
own words and is not a near-duplicate of a question already in the bank — otherwise the loop
would "close" gaps with questions that merely name-drop the requirement.

**At most two extra passes**, then stop. The loop is bounded because an unbounded one against a
free-tier quota is a way to spend a day's budget on one stubborn requirement, and because a
requirement the model has failed twice is not going to be covered on the third attempt. What is
still uncovered after that gets a **deterministic fallback question** built from the
requirement's own text — templated, invents nothing, and marked `origin: "fallback"` so it is
visibly not the model's work. Anything still uncovered is reported honestly in
`coverage.uncovered_requirement_ids` rather than quietly dropped.

---

## Retrieval

`fetch` and Cheerio — no headless browser.

The homepage is fetched, its links are extracted, and each is **scored by a heuristic ranker**:
URL path signals, anchor text, and where on the page the link sits. The top few by score are
fetched, up to a page budget. A fixed list of paths like `/careers` is explicitly not sufficient
per the brief, and it is also just wrong — the fixture set includes a site whose hiring material
is at a path no fixed list would guess, and one whose careers page is on an external ATS domain.

`robots.txt` is fetched and obeyed; unparseable means allow. Oversized pages are rejected rather
than truncated. Sitemaps are read when they exist, which is what rescues a client-rendered site
whose homepage has no links in its HTML at all.

**Sources used** are recorded on the kit: `company_brief.sources` is every URL consulted
including search results, and `pages_used` is the pages whose text actually reached a prompt.
The two are separate because they answer different questions.

Public discussion of a company's interview process comes from **Tavily** (free tier). The key is
optional and there is no branch in the pipeline for its absence — a null provider returns nothing,
the step records itself as skipped, and the brief says what it could not find.

---

## Robustness: the degradation ladder

- Search key absent or API down → no public-discussion section, recorded as a gap in the brief.
- Company site 404s or times out → kit generates from the JD alone, `pages_used` empty, brief
  says so honestly.
- Model returns invalid JSON → one repair attempt, then skip that step and record it.
- Budget exhausted mid-coverage → ship with gaps listed rather than looping.
- Provider 429s → queue and wait. Only after retries exhaust does a case become `failed`.

**A partial kit is `ok`. Only a kit that could not be produced at all is `failed`.** A missing
hiring page is not a failure.

Three more rungs this implementation adds, on the same principle:

- An inner page 404s or times out → skipped and reported; the crawl continues.
- One question category fails → that section is thinner, the rest of the kit is unaffected.
- A thin job description → a thin kit that says so, with `suspicious_extraction` on the trace.
  **Inventing requirements is worse than reporting there were few.**

### The one rung that behaves differently in batch

The second bullet describes the interactive app. `scripts/evaluate.ts` takes the other reading
and treats an unreachable homepage as `failed: COMPANY_UNREACHABLE`, because Appendix B's own
worked example shows exactly that entry and the graders' harness may assert on it.

Both readings are defensible and the specification contains both, so it is one flag
(`treatUnreachableSiteAsFailure`) rather than a decision baked in — batch is judged against the
specification, the app is judged by whoever is using it. Someone who pastes a URL that 404s
wants the kit their description can still produce.

---

## Security

**SSRF.** Every outbound URL is validated against the **resolved address**, not the hostname — a
hostname check is defeated by a DNS record pointing at `169.254.169.254`. Loopback, private
ranges, link-local and the cloud metadata addresses are rejected.

**`ALLOW_PRIVATE_HOSTS`** exists because the specification contradicts itself here, and honestly
so: Appendix B's own example serves its cases from `http://localhost:8099/acme/`, while the
security requirements say to reject loopback. Both are right for their environment. So it is an
environment flag, defaulting off, that `npm run evaluate` turns on for itself and nothing else
does. The deploy script pins it to `false` in production and does not let the deployment
override it.

**What the model asserted, against what it was shown.** Extraction has always checked this:
`checkGrounding` drops a requirement whose distinctive words are not in the posting, because the
brief's words are that nothing is invented. The company brief had no equivalent — so an invented
*requirement* was dropped and recorded, while an invented *fact about the company* shipped to a
candidate who was about to walk into an interview believing it.

`checkClaims` closes that. It is deliberately not `checkGrounding`: a brief is a summary and
rewords by design, so demanding token overlap from prose would flag every competent sentence. It
looks only at the parts of a sentence that cannot be reworded and that a reader would act on —
**names** (proper nouns, technologies) and **numbers** (amounts, years, counts). A sentence that
turned "we help marketplaces move money" into "they build payment infrastructure" carries neither
and is correctly ignored.

Nothing is removed. The count, and a sample, go on the span — `claims_checked` beside
`unsupported_claims`, because zero unsupported out of zero checked is a brief nobody could verify
rather than one that passed. Dropping a sentence from a summary is blunter than dropping one
requirement from a list: the prose around it stops making sense, and a false positive silently
deletes a true statement. Recording it is also what makes the check safe to run over question
text, where invention is partly the point.

Its limit is stated rather than engineered around: it tests whether a token is *present*, not
whether it is *entailed*. A question about `EXPLAIN` against a requirement that says "query
tuning" is flagged, and that is why question-side claims are a smell and never acted on.

**A prompt ceiling, as a bug detector.** Every input is already capped — the posting at 12,000
characters, a page at 3,000, the crawl at eight pages — so the largest legitimate request is
around ten thousand tokens. The gateway refuses anything over 32,000 and records `prompt_chars`
and `input_tokens` on every span regardless. It never fires on a healthy run, which is the point:
what it catches is a truncation that stopped truncating, arriving otherwise as a provider 400 at
whichever context limit the fallback chain happened to reach.

**Prompt injection: mitigated, not solved.** The pipeline fetches arbitrary company pages and
puts their text in front of a model. Retrieved content is fenced in delimited blocks and labelled
as data with an explicit instruction that it is not instructions. The rewrite prompt the user
types in the composer is fenced the same way, even though it came from the signed-in user — a JD
pasted off a site can be re-pasted into that field, and an instruction block that is trusted for
one input is a hole for every input that can reach it. Its wrapper grants exactly one power
(change the emphasis, difficulty and subject matter of this section) and is capped at 600
characters, refused at the API edge rather than silently truncated later. That raises the bar; it
does not clear it. What actually bounds the damage is the architecture: the model cannot allocate the
schedule, cannot decide coverage, cannot rank links and cannot assign requirement ids, so the
worst a hostile page can achieve is a bad question — not a corrupted kit, and not a request to
anywhere it chose.

---

## Practice and the creative features

**Practice** deals one flashcard at a time, reveals on click, and takes a three-way rating —
Knew it / Shaky / Again. The card in front of you can be edited or deleted without leaving the
deck, and a new one written there too: the deck is where you notice the bank is missing
something, in the same way it is where you notice a card is wrong. A card written by hand is
`manual`, so no regeneration will take it away. Ratings live in their own `practice_sessions` collection, not on the
kit: a rating log grows with use and a kit does not, and embedding it would make every builder
read carry a month of history it has no use for.

The next session is **ordered by lowest confidence**, computed on the server from the whole
rating history. The order is: an explicit *Again* first, then cards never dealt, then *Shaky*,
then *Knew it*, ties broken by least-recently-rated. An explicit Again outranks a never-dealt
card deliberately — both are things you cannot do yet, but one of them is a person saying so.
The order is held for the length of a sitting, because a deck that re-sorted itself as you rated
would move the card you were about to see.

Two creative features, both deterministic and neither costing a model call:

* **A weak-spots report.** Card confidence is attributed back to question tracks through shared
  requirement ids, ranking which parts of the role you are least ready for. Tracks you have not
  rated are excluded rather than scored zero — a track you have not opened is not a weak track,
  and averaging the two together is how a report starts lying.
* **Cross-kit comparison.** When you have several kits, the requirements that recur across them
  are clustered (reusing the coverage package's own matching) and shown together — the things
  every role you are chasing wants, which is the thing worth studying first.

---

## Testing

```bash
npm test                          # 734 unit tests, 26 files
npm run eval:step -- all          # the step-by-step eval suite
npm run eval:step -- 14           # one step
```

The three areas the brief names — schedule allocation, coverage checking, structure validation —
are covered directly, along with the gateway's rate limiting and backoff, SSRF, crawling, the
builder's state transitions, and the API contract.

`evals/` is a second suite: one folder per pipeline step, each with a `cases.json` of inputs and
expected properties. Pure steps must pass 100%; the three LLM steps report a pass rate over
repeated runs, because a property that passes two runs in three is a flaky prompt and not a pass.
Step 13 covers builder regeneration and step 14 boots the whole API against the memory adapter
with a fake Clerk verifier — ownership, versions, idempotency and the event stream.

---

## Trade-offs and known limitations

**Gemini's free tier is a daily cap, not a rate limit.** Roughly twenty requests per day per
model, and one kit costs six to eight calls — so a free-tier key supports two or three
generations per day *across everyone using a deployed link*. The gateway's RPM and TPM buckets do
not help with this; nothing does except a paid key or another provider. This is why the Z.AI and
OpenRouter rungs exist, and it is the single most likely reason a live demo link disappoints.

**Traces are not persisted.** They live in the API process, which is why the deployment runs on a
single replica and never scales to zero. A revision deployed mid-run loses that run's spans; the
kit itself is already in Mongo. Persisting job state is the first thing to do if this ever needs
to scale.

**No emit step.** `npm run build` is a typecheck and the container runs TypeScript under `tsx`.
The dependency rule lives in tsconfig paths and every consumer resolves source, so a bundler
would introduce a second, divergent module graph for no gain at this size.

**Deployment is on Azure credits, not a free tier.** The brief expects free tiers, and MongoDB
Atlas, Clerk, Gemini and Tavily all are. Container Apps is not — it is what was available, and
saying so is better than leaving it unremarked. The Dockerfile is ordinary and the API runs
anywhere that takes a container.

**Both deployments are triggered by hand.** For a one-day build, a pipeline that has never run is
worth less than a script that has.

**The builder's persistence is commit-on-blur, not a debounce timer.** It satisfies "no round
trip per keystroke" and it is not the same thing.

**`docs/DECISIONS.md` is long.** It is written in build order, as a record of what was decided
and why rather than as a reference — if you want one thing, use the headings.
