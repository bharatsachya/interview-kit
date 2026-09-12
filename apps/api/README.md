# apps/api

The Express API, and one of the three composition roots.

## `main.ts` is where adapters are built

Nothing else in the repository constructs one. It reads the environment and decides: Clerk or
dev auth, Mongo or memory, Gemini/Z.AI/OpenRouter or the fake, live fetch or fixtures — then
hands the wiring to `createApp`. It prints what it chose on startup, because a demo that silently
fell back to memory is a demo that loses your kits on restart without telling you.

`npm run api:fake` is the whole thing with `FAKE_LLM` and `FAKE_FETCH`: no key, no database.

## The route files

| File | Holds |
|---|---|
| `app.ts` | assembly, `GET /kits`, `GET /jobs`, health |
| `builder.ts` | the fourteen builder routes and the rewrite trigger |
| `practice.ts` | the deck and the rating log |
| `events.ts` | `GET /jobs/:id/events` — the SSE stream a running kit is watched through |
| `jobs.ts` | `JobRunner` — the background queue, idempotency, progress, forking |
| `schemas.ts` | every request body, as strict zod |
| `spans.ts` | `JobSpanFeed` — where a running job's spans go so the stream can replay them |
| `http.ts` | `guarded`, `parseBody`, the error shapes |

## Five things every builder route does, in this order

Authenticate → prove ownership → validate the body → apply one named transition from
`@trao/kit` → return the builder projection with the new version in an `ETag`.

**None of them contains a state rule.** What survives a regeneration, what an edit does to
provenance, where a moved question lands — all of it is in `packages/kit`, tested without an HTTP
server in front of it.

**Ownership is checked before the body is looked at.** A stranger poking at a kit id should not
learn which of their fields was malformed, and a 400 where a 404 belongs tells them the kit
exists.

**Every write returns the whole kit.** A reorder changes every sibling's index and a delete takes
a flashcard and a schedule slot with it; a response describing only what was asked for would
leave the client to model those consequences a second time.

## Generation is a job, not a request

`POST /kits` answers `202` with a job id immediately. A ninety-second HTTP request dies on
free-tier hosts, and a job id makes the run survive a closed tab and gives it a shareable URL.
Progress is read from the tracer's own spans rather than a hand-maintained step list — a second
list would be a second source of truth and would be wrong the first time a step was renamed.

Idempotency is by `(user, hash of JD + company_url + days)`, claimed **before the first await**,
so two requests arriving in the same tick do not both start a run.

## Rewrites fork

`POST /kits/:id/regenerate` reads the kit in its URL and never writes to it. The result is saved
as a new kit whose id was reserved before any model was called and returned as `kit_id`. See the
root README and `docs/DECISIONS.md`.

## Tests

`test/api.test.ts` — ownership, versions, idempotency, the event stream and the fork semantics,
against a real Express app with a fake Clerk verifier and memory stores.
