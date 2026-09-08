---
name: 09-batch-evaluate
description: Implement the mandatory npm run evaluate batch entry point, the Appendix B output shape, the memory persistence adapter, and the clean-clone requirement. Use this skill whenever working on scripts/evaluate.ts, cases.json or kits.json, batch processing multiple job descriptions, the fifteen-minute five-case budget, recording a case as ok versus failed, .env.example, or anything that must run without MongoDB. Trigger this whenever persistence or auth is about to be required by the pipeline — batch mode has no database and no user, and 55 automated points depend on it running from a clean clone.
---

# Batch entry point

Block H9. **This is the highest-risk item in the submission** — 55 automated points run
through this command.

## The frozen command

```bash
npm run evaluate -- --input <cases.json> --output <kits.json>
```

Exact. Not negotiable.

## Input (Appendix B)

```json
[{ "id": "case-01",
   "jd": "Senior Backend Engineer\n\nWe are looking for ...",
   "company_url": "http://localhost:8099/acme/",
   "days": 5 }]
```

Note the localhost URL — see the SSRF flag below.

## Output (Appendix B)

```json
{ "version": "1.0",
  "generated_at": "2026-09-01T09:12:44Z",
  "kits": [
    { "id": "case-01", "status": "ok",  "kit": { ...Appendix A... }, "error": null },
    { "id": "case-04", "status": "failed", "kit": null,
      "error": { "code": "COMPANY_UNREACHABLE",
                 "message": "Company site unreachable after 3 retries." } }
  ] }
```

One entry per input case, any order, keyed by the given id.

## Requirements

- Runs your **full retrieval, generation and validation path** — the same code the app uses,
  not a parallel implementation. `scripts/evaluate.ts` imports the pipeline service directly.
- Uses the `days` value given per case.
- **Continues after one case fails**, recording the failure rather than aborting.
- **Five cases within fifteen minutes**, including retries that rate limits force.
- Reads credentials from env vars documented in `.env.example`, and needs **no setup beyond
  the documented install step**.
- **Must run from a clean clone.**

## No MongoDB

The graders clone fresh and run one command. If it needs a connection string they have not set
up, 55 points are lost to a setup failure.

Batch mode uses the **memory persistence adapter** plus a **file cache**. No user, no reopening,
no browser polling — none of what the database exists for applies here.

## No auth

`pipeline` never imports `auth`. Kit ownership is a field the API layer attaches, not something
the pipeline knows about. This is why Clerk must stay entirely inside `apps/api`.

## ok vs failed

**Reserve `failed` for a case you could not produce a kit for at all.**

A case you could only partially research is `ok`, with the gaps recorded honestly in the kit.
A missing hiring page is **not** a failure. A thin JD is not a failure.

## Fitting fifteen minutes

- ~8 calls per case × 5 cases = 40 calls. At 10 RPM that is 4 minutes of queueing alone.
- Run 2–3 cases concurrently, steps serial within a case, against one shared token budget.
- **Per-case timeout** so one hung case cannot eat the whole window.
- The cache makes repeat runs nearly free during development — but test a `--no-cache` run at
  least once before submitting.

## SSRF flag

Appendix B serves from `http://localhost:8099/acme/` while section 11 says reject loopback in
production. Batch needs `ALLOW_PRIVATE_HOSTS=true`, defaulted off, documented in
`.env.example` and explained in the README as a deliberate decision.

Retrieval must never assume a host and must follow relative links.

## .env.example

Every variable, each with a comment saying what it is for. Mark the search key **optional** —
its absence must degrade, not crash.

## Tests

- Runs from a clean clone with no MongoDB.
- Five fixture cases complete within fifteen minutes.
- Output matches Appendix B exactly: `version`, `generated_at`, `kits[]` with `id`, `status`,
  `kit`, `error`.
- One failing case does not abort the run.
- Every `ok` kit passes the Appendix A validator.
- A case with a sparse site is `ok`, not `failed`.

## Done when

`git clone` → documented install → `npm run evaluate` produces valid output on a machine with
no database and only the env vars in `.env.example`.
