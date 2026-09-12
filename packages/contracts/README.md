# @trao/contracts

Interfaces and shared types. **Imports nothing, ever** — not a package, not a library, not zod.

This is the bottom of the graph and the reason the rest of it stays flat. Every other package
depends on this one and on nothing else horizontally; packages receive their dependencies as
arguments, and only the three composition roots (`apps/api/src/main.ts`, `scripts/evaluate.ts`,
`scripts/dev.ts` — all via `scripts/composition.ts`) ever construct an adapter.

## What is in here

| File | Holds |
|---|---|
| `llm.ts` | `LlmProvider`, `LlmRequest`, `LlmResult` — the one shape a model call has |
| `retrieval.ts` | `HttpFetcher`, `SearchProvider`, and the fetch result types |
| `persistence.ts` | `KitStore`, `JobStore`, `UserStore`, `KitRecord`, `JobRecord` |
| `practice.ts` | `PracticeStore` and the rating log's shape |
| `cache.ts` | `CacheStore` |
| `tracing.ts` | `Tracer`, `SpanHandle`, `Span`, `NOOP_SPAN` |
| `time.ts` | `Clock`, `IdGenerator` |
| `budget.ts` | `Budget` — a run's deadline, threaded through every step |
| `errors.ts` | `KitError`, `toErrorShape` — one error vocabulary across the whole build |
| `prompt.ts` | `untrustedBlock`, `truncateForPrompt`, `MAX_INSTRUCTION_CHARS` |

## Two rules worth naming

**An interface exists only where there is a real second implementation.** Memory vs Mongo, null
vs Tavily, fake vs real LLM, noop vs in-memory tracer. Domain logic is not abstracted — there is
no `IQuestionGenerator`, because there would only ever be one.

**Prompt hygiene lives here, not in `llm`.** Every package that *writes* a prompt needs
`untrustedBlock` — extraction and generation both embed untrusted text — and none of them may
import `llm`. They are shared vocabulary for talking to a model in the same sense `LlmRequest`
is, so they sit next to it. `contracts` still imports nothing.

## How the dependency rule is actually enforced

**By the compiler.** `npm run typecheck` runs `tsc` once per package against a `tsconfig.json`
whose `paths` list only the packages that one is allowed to import. `contracts` has an empty
allowlist. A forbidden import is a type error, not a convention.

`test/dependency-rule.test.ts` guards *that mechanism* rather than the import graph itself,
because the mechanism has a silent failure mode: npm workspaces symlinks every `@trao/*` package
into the root `node_modules`, so a `main` or `exports` field in any package manifest would let
TypeScript resolve anything from anywhere and bypass the allowlists entirely — without breaking
a single build. The test asserts that no package declares either field, that every package
extends the base config with an explicit `paths` allowlist, and that `contracts`' allowlist is
empty. A future `package.json` written from habit is what it exists to notice.
