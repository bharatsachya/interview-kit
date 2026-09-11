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
| [The builder](#the-builder-and-the-state-problem) | what is editable, and how an edit survives a regeneration |
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

**OpenRouter** is supported as a second provider, on its free models. Not redundancy for its own
sake: Gemini's free tier is a *daily cap* of roughly twenty requests per model rather than a
rate limit, so once it is spent, waiting does nothing. OpenRouter's free models draw on a
different bucket. Set `LLM_PROVIDER` to pick when both keys are present.

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
questions survive, as does every other section.

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
checks and forgets to bump cannot be written.

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

**Prompt injection: mitigated, not solved.** The pipeline fetches arbitrary company pages and
puts their text in front of a model. Retrieved content is fenced in delimited blocks and labelled
as data with an explicit instruction that it is not instructions. That raises the bar; it does
not clear it. What actually bounds the damage is the architecture: the model cannot allocate the
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
not help with this; nothing does except a paid key or a second provider. This is why OpenRouter
support exists, and it is the single most likely reason a live demo link disappoints.

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
