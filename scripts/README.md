# scripts

Entry points and repo tooling. Two of the three composition roots live here.

## The frozen one

```
npm run evaluate -- --input <cases.json> --output <kits.json>
```

`evaluate.ts`. **The highest-risk item in the submission** — 55 automated points run through this
one command, on a machine that has just cloned the repository. Everything about it is shaped by
that:

* **No database.** Batch mode has no user, nothing to reopen and no browser polling, so nothing
  MongoDB exists for applies. A connection string the graders had not set up would lose 55 points
  to a setup failure rather than to the code.
* **No auth.** `pipeline` never imports `auth`; ownership is a field the API layer attaches.
* **The same code path as the app.** It imports `@trao/pipeline` directly — there is no parallel
  batch implementation to drift.
* **One failing case never aborts the run.** Each case is isolated and recorded as `failed` with
  its error; the rest still produce kits.
* **`ALLOW_PRIVATE_HOSTS` defaults on here**, because Appendix B's own example serves from
  `http://localhost:8099/acme/`.

Output is validated against Appendix B before it is written.

## The rest

| Script | Command | Does |
|---|---|---|
| `dev.ts` | `npm run dev:kit` | One case, headless, no UI, no database. With `--fake-llm --fake-fetch` a full nine-step run takes well under a second and zero quota — the single biggest speed-up in the build, because debugging through the interface costs a minute a time. `--trace-pretty` prints the span tree. |
| `composition.ts` | — | The shared wiring both `evaluate.ts` and `dev.ts` use: which provider, which fetcher, which stores, read from the environment. The provider chain (Gemini → Z.AI → OpenRouter) and `LLM_PROVIDER` live here. |
| `dev-all.mjs` | `npm run dev` | API and web together, fakes by default; `npm run dev:real` for real providers. |
| `smoke.ts` | `npm run smoke` | End-to-end sanity check against a running API. |
| `trace-view.ts` | `npm run trace` | Renders a saved trace JSON as a span tree. |
| `check-output.ts` | `npm run check:output` | Validates a `kits.json` against Appendix B without re-running anything. |
| `typecheck.mjs` | `npm run typecheck` | Type-checks all nineteen projects, generating the Next route types first. The per-package `tsconfig.json` allowlists are what make the dependency rule a compile error. |
| `commit-validate.ts` / `push-validate.ts` | git hooks | Lockfile guard, large-file blocker, merge-conflict markers, trailing whitespace, "no source hidden by .gitignore", and a check that the frozen batch command is still intact. |
| `load-env.ts` | — | `.env` loading shared by every entry point. |

`lib/` holds the pieces the two validate scripts share — git plumbing, the check definitions,
and the terminal output format.
