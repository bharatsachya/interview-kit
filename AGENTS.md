# CLAUDE.md — AI Interview Prep Kit

High-level guide. Detail lives in `.claude/skills/` — read the relevant skill before writing
code in that area.

---

## What this is

A web app that turns a pasted job description + company URL + days-until-interview into a
researched, editable interview prep kit: company brief, role breakdown, categorised question
bank, flashcards, and a day-by-day study schedule.

Built for the Trao Full-Stack Engineering Assessment (FS-AI-INTERVIEW-01). One-day build.

## Two things are frozen

1. **The kit structure (Appendix A)** — field names exactly as given.
2. **The batch command** — `npm run evaluate -- --input <cases.json> --output <kits.json>`,
   output shaped per Appendix B.

Everything else is a design decision, and every decision needs a README line — the rubric
reads for judgment, not just output.

---

## Skills

| Skill | Covers |
|---|---|
| `01-foundation` | monorepo, `contracts`, `Tracer`, the dependency rule |
| `02-kit-structure` | Appendix A, Zod validation, projections, soft delete, schedule repair |
| `03-scheduling` | day allocation, front-loading, 1-day and 60-day cases |
| `04-coverage` | gap detection, acceptance gates, clustering, deterministic fallback |
| `05-llm-gateway` | RPM/TPM buckets, backoff, cache, JSON repair, `FakeLlmProvider` |
| `06-retrieval` | crawling, link ranking, robots, SSRF, Tavily, fixture sites |
| `07-extraction-generation` | JD → requirements, brief, four-category question generation |
| `08-pipeline-tracing` | the nine steps, degradation ladder, headless dev runner |
| `09-batch-evaluate` | `npm run evaluate`, Appendix B, clean-clone, no MongoDB |
| `10-frontend` | create, progress, kit view, builder, practice mode |

---

## Stack

Next.js + Tailwind · Node + Express · TypeScript · MongoDB · Clerk · Gemini Flash → Z.AI (GLM)
→ OpenRouter, one model list across all three · Tavily (free tier, key optional) · fetch +
Cheerio (no headless browser) · Vitest · Azure Container Apps + Vercel.

Deviations to justify in the README: Clerk instead of hand-rolled auth (brief says keep auth
minimal and does not score it), and deployment on Azure credits (the brief expects free tiers —
say so rather than leaving it unremarked).

---

## Scoring map

| Item | Points | Skill |
|---|---|---|
| Requirement extraction | 20 | `07` |
| The builder | 15 | `10` + `02` |
| Coverage + schedule | 15 | `03`, `04` |
| Research + sequencing | 10 | `06`, `07`, `08` |
| Robustness | 10 | `05`, `08` |
| Interaction design | 10 | `10` |
| Code quality + README | 10 | all |
| Practice mode + creative feature | 10 | `10` |

Extraction and the builder are the two biggest single items.

---

## Architecture in one rule

```
apps/          web (Next.js) · api (Express, composition root)
packages/      contracts · kit · llm · retrieval · research · extraction
               generation · coverage · scheduling · persistence · cache
               auth · pipeline
scripts/       evaluate.ts · dev.ts
```

**Every package depends on `contracts` and nothing else horizontally.** Packages receive their
dependencies as arguments. Only `apps/api/main.ts`, `scripts/evaluate.ts` and `scripts/dev.ts`
construct adapters.

Exceptions: `pipeline` imports every domain package by design, `kit` is imported by anything
producing kit-shaped data, `contracts` imports nothing ever.

Interfaces exist only where there is a real second implementation (memory vs mongo, null vs
tavily, fake vs real LLM). Do not abstract domain logic.

---

## The pipeline

1. extract_requirements · 2. fetch_homepage · 3. crawl_site · 4. search_discussion ·
5. generate_brief · 6. generate_questions (four separate calls) · 7. coverage_check ·
8. gap_fill (loop to 7, max 2 extra passes) · 9. derive_flashcards + allocate_schedule

**What the model is never allowed to decide:** schedule allocation, coverage gap detection,
link ranking, and the requirement ids on gap-fill questions. The first two are named in the
brief; the second two are ours. This is the thing the graders read for.

---

## Working rules

- **Fakes before real providers.** `--fake-llm --fake-fetch` gives a full pipeline run in under
  a second with zero quota. Everything up to block H7 needs no API key and no database.
- **Trace before pipeline.** Every step wrapped in a span from the first line it is written.
  Debugging through the UI is not affordable in one day.
- **Tests in the same session as the code**, not at the end. Three areas are named by the
  brief: schedule allocation, coverage checking, structure validation.
- **Commit at every block boundary.** Commit history is explicitly graded.
- **Honest degradation beats clever recovery.** A partial kit is `ok`; only a kit that could
  not be produced at all is `failed`. A thin JD produces a thin kit that says so. Inventing
  requirements is worse than reporting there were few.

---

## Build order

| Block | What | Skill |
|---|---|---|
| H1 | scaffold, contracts, tracer | `01` |
| H2 | kit — types, Zod, projections, repair | `02` |
| H3 | scheduling + coverage + tests | `03`, `04` |
| H4 | llm gateway + FakeLlmProvider | `05` |
| H5 | retrieval + FakeFetcher + fixtures | `06` |
| H6 | extraction, research, generation | `07`, `06` |
| H7 | pipeline + dev runner, first full fake run | `08` |
| H8 | swap in real Gemini + Tavily, tune the limiter | `05` |
| H9 | evaluate.ts + Appendix B + five-case run | `09` |
| H10 | Express API + Clerk + job endpoints | `10` |
| H11 | Next.js create → progress → kit view | `10` |
| H12 | builder (largest UI item, own block) | `10`, `02` |
| H13 | practice mode + keyboard + responsive | `10` |
| H14 | deploy, `.env.example`, README, video | — |

**H1–H7 need no API key and no database.** If the day runs long, it runs long on the UI — the
55 automated points are already green by H9.

---

## Open decisions

- **Creative feature** — optional, shares 10 points with practice mode. If built, a "weak
  spots" report driven by real practice confidence data reuses data you already have.
- **60-day schedule policy** — spaced review days vs thin days. Pick one; the scheduling test
  needs something to assert.

---

## README must cover

Overview and stack with justification · setup local and deployed, exact batch commands · LLM
provider and model · architecture · retrieval approach and sources used · how the steps are
sequenced and what each is responsible for · how generated/edited/pinned state is represented ·
how the schedule is allocated · the creative feature if any · key trade-offs and known
limitations.

Plus, because they are graded and easy to omit: the degradation ladder, why
`ALLOW_PRIVATE_HOSTS` exists, how many coverage passes and why, and the prompt-injection
posture (mitigated, not solved).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
