# Decisions

Running log, written as each block lands. The README is assembled from this at H14 — the
rubric reads for judgment, so every non-obvious choice needs the reason recorded while the
reason is still fresh.

---

## H1 — foundation

### `packages/kernel` exists, beyond the package list in CLAUDE.md

`contracts` is interfaces and shared types only, so the `Tracer`, `Clock` and `IdGenerator`
implementations needed a home that was not `contracts` and not a domain package. All three
clear the bar for existing: each has a genuine second implementation — `NoopTracer` vs
`InMemoryTracer`, `SystemClock` vs `FixedClock`, `RandomIdGenerator` vs `SequentialIdGenerator`.
None is an interface invented for one implementation.

### The dependency rule is a compile error, not a convention

Three mechanisms, and all three are needed:

1. Each package's `tsconfig.json` declares `paths` for only the packages it may import.
   `contracts` has `"paths": {}` — it imports nothing, ever.
2. No package exposes `main` or `exports`. npm workspaces symlinks every `@trao/*` package
   into the root `node_modules`, so either field would let TypeScript resolve any package from
   any package and the allowlists would be decorative.
3. `npm run typecheck` runs tsc once per package against *its* config. The root
   `tsconfig.json` maps everything and is deliberately excluded — tsx and vitest need it to
   resolve everything at runtime.

Verified rather than assumed: with `node_modules/@trao/kernel` symlinked and present,
`import { NoopTracer } from "@trao/kernel"` inside `contracts` fails with TS2307.
`packages/contracts/test/dependency-rule.test.ts` guards mechanism 2, which is the one that
could silently rot — a `main` field added from habit would break enforcement without breaking
a build.

### Persistence interfaces are generic over the kit type

`KitStore<TKit = unknown>` rather than `KitStore` importing the kit type. `contracts` imports
nothing, and the kit document type lives in `packages/kit`. This is not a dodge: a store
persists and returns a document, it never interprets one. Only the composition roots pin the
parameter, as `KitStore<InternalKit>`.

### `OutputSchema<T>` is structural, so contracts needs no Zod dependency

```ts
safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } }
```

Zod schemas satisfy this as-is. The gateway still gets a real parse and a real error message
to feed back on the single JSON-repair retry, and `contracts` stays dependency-free.

### `Clock` carries `sleep()`, not just `now()`

The skill sketch had `now()` alone. `sleep` belongs on the same seam because H4's rate limiter
is the thing that most needs deterministic time: `FixedClock.sleep` advances virtual time and
resolves on the next microtask, so queueing, exponential backoff and `Retry-After` handling can
be asserted exactly, in milliseconds, instead of approximated with real timers. Sleepers wake
in wake-time order rather than call order, so a 5s waiter cannot overtake a 1s one.

Consequence, to be held to for the rest of the build: nothing in the repo calls `Date.now()`,
`new Date()`, `setTimeout` or `crypto.randomUUID` directly. It takes a `Clock` or an
`IdGenerator`.

### `SpanHandle.child(step, fn)` takes the function

The sketch had `child(step): SpanHandle`, which has no defined end — an unclosed child span can
leak into the trace. Passing the function in makes the lifetime explicit.

Parenting is also implicit, via `AsyncLocalStorage`: a `tracer.span()` call made anywhere inside
a running span becomes its child, so a step does not have to thread a handle down through every
helper it calls. That also parents concurrent siblings correctly, which a current-span stack
gets wrong the moment two fetches overlap — and `crawl_site` overlaps fetches by design.

Spans are recorded at start and mutated at end, so `export()` returns them in start order.
End order reads backwards: the innermost step appears before the step that called it.

### Not a build step

Packages are consumed from source through tsconfig `paths`, run by tsx and vitest. No
per-package compile, no project references, no `dist/` to stale. `npm run build` is currently
`npm run typecheck`; the API bundle is added at H14 when there is something to deploy.

### Open, still to decide

- 60-day schedule policy: spaced review days vs thin days (needed by H3, the scheduling test
  has to assert one of them).
- Whether to build the creative feature at all — shares 10 points with practice mode.
