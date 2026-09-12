# @trao/kernel

The zero-dependency implementations of the cross-cutting contracts: `Tracer`, `Clock`,
`IdGenerator`.

Imports `@trao/contracts` and nothing else. Everything in here has a real second implementation,
which is the bar for the interface existing at all.

## What it provides

| Export | Second implementation, and why |
|---|---|
| `InMemoryTracer` / `NoopTracer` | A run that is being watched vs one that is not. The in-memory tracer parents spans through `AsyncLocalStorage`, so the four concurrent question calls nest under the right parent rather than under whichever finished first. |
| `SystemClock` / `FixedClock` | Wall time vs a test that needs to assert a timestamp. |
| `SequentialIdGenerator` / `RandomIdGenerator` / `ScriptedIdGenerator` | `q1, q2, q3…` makes a `--fake-llm` run byte-identical between invocations, which is what lets the eval suite diff output. Random is what production wants. Scripted is for a test that needs to name an id before it exists. |
| `RoutedIdGenerator` | Different prefixes from different generators — a job runner that mints durable `kit_`/`job_` ids while a per-run generator counts `q1…` inside one document. |
| `formatTrace` | A span tree as text, for `npm run dev:kit --trace-pretty` and `npm run trace`. |

## Why `AsyncLocalStorage` and not a depth counter

The tracer kept a push/pop depth stack, which is correct only while spans nest strictly. The
moment the four question categories started running concurrently their pushes and pops
interleaved, and three of the four were attributed to the wrong parent — the test failed while
the code was right. `packages/pipeline/test/doubles.ts` models the same way for the same reason:
a double that handles concurrency differently from the real thing tests the double.
