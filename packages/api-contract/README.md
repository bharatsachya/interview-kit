# @trao/api-contract

The wire shapes shared by `apps/web` and `apps/api`.

Imports `@trao/contracts` and `@trao/kit`.

## Why it is not in `contracts`

These types were written inside `apps/web/src/lib/api/types.ts` with a note saying they belonged
in `contracts` once there were two callers. There now are — but they cannot go there.
`contracts` imports nothing and therefore cannot see `InternalKit` or `EvaluationCase`. A package
that may import both `contracts` and `kit` is where HTTP shapes actually belong, and naming it
for what it is beats filing them inside the kit document package.

## Composed, never restated

Every shape is built from the existing types: `JobRecordView` is `Omit<JobRecord, "request"> & {
retryable: boolean }`, `CreateKitRequest` is `Pick<EvaluationCase, "jd" | "company_url" |
"days">`. A parallel frontend definition would drift the first time one of them gained a field,
and the drift would surface as a runtime surprise rather than a type error.

## The surface

| Shape | Route |
|---|---|
| `CreateKitRequest` / `CreateKitResponse` | `POST /kits` |
| `CreateBatchRequest` / `CreateJobsResponse` | `POST /kits/batch` |
| `RegenerateRequest` / `RegenerateResponse` | `POST /kits/:id/regenerate` |
| `KitView` | every builder read and write |
| `KitExport` | `GET /kits/:id/export` — Appendix A, unwrapped |
| `KitSummary` / `KitListView` | `GET /kits` |
| `JobSummary` / `JobView` / `JobRecordView` | `GET /jobs`, `GET /jobs/:id` |
| `PracticeView` | `GET /kits/:id/practice` |

Field names on the wire are `snake_case`, matching Appendix A and the rest of the HTTP surface.
The mapping onto internal `camelCase` happens in the route, by hand, one field at a time.

## Two shapes worth reading the comments on

`CreateKitResponse.kit_id` is reserved **before** the pipeline runs. The second of two identical
submissions has to be answered with the id of the first, and at that moment the first has not
produced anything — so either the id exists up front or a double-submitted form gets two kits.

`RegenerateResponse.kit_id` is the **new** kit a rewrite will produce. The kit in the URL is read
and never written: a rewrite forks, so the version you had is still there to go back to.
