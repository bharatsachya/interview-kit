import { AsyncLocalStorage } from "node:async_hooks";
import {
  toErrorShape,
  type Clock,
  type Span,
  type SpanHandle,
  type SpanStatus,
  type Tracer,
} from "@trao/contracts";
import { SystemClock } from "./clock";

/**
 * Records every span in memory and hands the tree back with `export()`.
 *
 * Parenting is implicit, via AsyncLocalStorage: a `tracer.span()` call made anywhere inside a
 * running span becomes its child, so a step does not have to thread a handle down through
 * every helper. That also parents concurrent siblings correctly, which a current-span stack
 * would get wrong the moment two fetches overlap.
 */
export class InMemoryTracer implements Tracer {
  readonly #spans: Span[] = [];
  readonly #currentSpanId = new AsyncLocalStorage<string>();
  #seq = 0;

  constructor(private readonly clock: Clock = new SystemClock()) {}

  span<T>(step: string, fn: (s: SpanHandle) => Promise<T>): Promise<T> {
    return this.#run(this.#currentSpanId.getStore() ?? null, step, fn);
  }

  export(): Span[] {
    // Copies — a caller inspecting the trace must not be able to edit it.
    return this.#spans.map((s) => ({ ...s, attrs: { ...s.attrs }, ...(s.error ? { error: { ...s.error } } : {}) }));
  }

  async #run<T>(parentId: string | null, step: string, fn: (s: SpanHandle) => Promise<T>): Promise<T> {
    const id = `s${(this.#seq += 1)}`;
    const startedAt = this.clock.now();

    // Recorded at start, mutated at end, so `export()` comes back in start order. End order
    // would read backwards: the innermost step would appear before the step that called it.
    const span: Span = {
      id,
      parentId,
      step,
      startedAt,
      endedAt: startedAt,
      durationMs: 0,
      // Settles to ok, skipped or failed when the step returns. Until then a watcher can tell
      // "this is taking ninety seconds" from "this took no time at all".
      status: "running",
      attrs: {},
    };
    this.#spans.push(span);

    let status: SpanStatus = "ok";
    const handle: SpanHandle = {
      id,
      set: (key, value) => {
        span.attrs[key] = value;
      },
      setAll: (attrs) => {
        Object.assign(span.attrs, attrs);
      },
      skip: (reason) => {
        status = "skipped";
        span.attrs["skip_reason"] = reason;
      },
      child: (childStep, childFn) => this.#run(id, childStep, childFn),
    };

    const finish = (): void => {
      span.endedAt = this.clock.now();
      span.durationMs = span.endedAt - span.startedAt;
    };

    try {
      const result = await this.#currentSpanId.run(id, () => fn(handle));
      span.status = status;
      finish();
      return result;
    } catch (error) {
      // A thrown step is always `failed`, even if it called skip() on the way out.
      span.status = "failed";
      span.error = toErrorShape(error);
      finish();
      throw error;
    }
  }
}

/** Satisfies the interface, records nothing. Production default where a trace is not consumed. */
export class NoopTracer implements Tracer {
  span<T>(_step: string, fn: (s: SpanHandle) => Promise<T>): Promise<T> {
    return fn(NOOP_HANDLE);
  }

  export(): Span[] {
    return [];
  }
}

const NOOP_HANDLE: SpanHandle = {
  id: "noop",
  set: () => {},
  setAll: () => {},
  skip: () => {},
  child: (_step, fn) => fn(NOOP_HANDLE),
};
