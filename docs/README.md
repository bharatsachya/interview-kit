# docs

| File | What it is |
|---|---|
| `DECISIONS.md` | The engineering log, in build order. Every non-obvious choice with the reasoning and — where there was one — the failure that forced it. This is the long-form companion to the root README; when the two overlap, the README is the summary and this is the argument. |
| `RUNNING.md` | Running it locally: the fake path (no key, no database), the real path, environment variables, and the batch command. |
| `DEPLOYING.md` | Vercel, Azure Container Apps, MongoDB Atlas and Clerk — including why the API runs on a single replica that never scales to zero (traces live in the process). |
| `design-system.html` | The visual reference for `apps/web/src/components/industry` — the colour scale, type scale, and every component in its states. Open it in a browser. |

The root `README.md` is the submission document: overview, stack and justification, setup,
architecture, retrieval approach, how the steps are sequenced, how state is represented, how the
schedule is allocated, trade-offs and known limitations.

`evals/README.md` covers the step-by-step eval suite.
