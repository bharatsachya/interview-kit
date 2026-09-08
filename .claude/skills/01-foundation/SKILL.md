---
name: 01-foundation
description: Scaffold the TypeScript monorepo, the contracts package, and the Tracer. Use this skill whenever setting up the workspace, creating or editing packages/contracts, defining any interface (LlmProvider, KitStore, SearchProvider, HttpFetcher, CacheStore, JobStore, Clock, IdGenerator, Tracer), wiring npm workspaces or tsconfig paths, or writing a composition root. Trigger this before writing any other package — everything imports contracts. Also trigger whenever someone asks where an interface should live or whether a package may import another package.
---

# Foundation — workspace, contracts, tracer

Block H1. Nothing else can be built until this is done.

## Deliverables

1. TypeScript monorepo with npm workspaces, matching the layout in CLAUDE.md.
2. `packages/contracts` — interfaces and shared types only.
3. `Tracer` + `NoopTracer` + `InMemoryTracer`.
4. Vitest configured at the root, one passing test.

## The dependency rule (enforce this everywhere)

Every package depends on `contracts` and **nothing else horizontally**. `extraction` does not
import `llm`; it receives an `LlmProvider` as an argument.

Only three files construct adapters:
- `apps/api/main.ts`
- `scripts/evaluate.ts`
- `scripts/dev.ts`

Encode this in tsconfig path mappings so a violation fails the build, not code review.

Permitted exceptions: `pipeline` imports every domain package (that is its job), `kit` is
imported by anything producing kit-shaped data, `contracts` imports nothing ever.

## Interfaces to define

```ts
KitStore        save, findById, findByHash, listByUser
UserStore       findById, create
JobStore        create, updateProgress, complete, fail
CacheStore      get(key), set(key, value, ttl)
LlmProvider     complete(prompt, schema) → parsed object
SearchProvider  search(query) → results[]
HttpFetcher     fetch(url) → { status, contentType, body }
Clock           now()
IdGenerator     next(prefix)
Tracer          span, export
```

`Clock` and `IdGenerator` exist so schedule allocation and kit output are deterministic in
tests. Do not skip them — without a fixed clock the schedule tests are flaky and without fixed
ids the kit snapshots never match.

## Tracer contract

```ts
type SpanStatus = "ok" | "skipped" | "failed";

interface Span {
  id: string;
  parentId: string | null;
  step: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: SpanStatus;
  attrs: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface SpanHandle {
  set(key: string, value: unknown): void;
  skip(reason: string): void;
  child(step: string): SpanHandle;
}

interface Tracer {
  span<T>(step: string, fn: (s: SpanHandle) => Promise<T>): Promise<T>;
  export(): Span[];
}
```

The tracer is built **before** the pipeline, not after. In a one-day build there is no time to
debug through the UI — every step gets a span from the first line it is written.

## Do not abstract domain logic

Interfaces exist only where there is a real second implementation: memory vs mongo, null vs
tavily, fake vs real LLM. A `SchedulerStrategy` interface with one implementation is
architecture theatre and a reviewer reading for engineering judgment will spot it.

## Tests

- `InMemoryTracer` records nested spans with correct parent ids.
- A span that throws is recorded `failed` with the error, and the error still propagates.
- `s.skip(reason)` produces status `skipped` with the reason in attrs.
- `NoopTracer` satisfies the interface and records nothing.

## Done when

`npm test` passes, `npm run build` compiles every package, and importing `llm` from
`extraction` is a type error.
