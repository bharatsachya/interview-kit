/**
 * Tracing contract.
 *
 * The tracer exists before the pipeline, not after it. Every pipeline step is wrapped in a
 * span from the first line it is written — in a one-day build there is no time to debug
 * through the UI, and the exported span tree doubles as the evidence that the crawl, the
 * search, the four separate question calls and the second coverage pass actually happened.
 */

export type SpanStatus = "ok" | "skipped" | "failed";

export interface SpanError {
  code: string;
  message: string;
}

export interface Span {
  id: string;
  parentId: string | null;
  step: string;
  /** Epoch milliseconds, from the injected Clock so tests are deterministic. */
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: SpanStatus;
  attrs: Record<string, unknown>;
  error?: SpanError;
}

export interface SpanHandle {
  readonly id: string;

  /** Attach a trace attribute. Overwrites a previous value for the same key. */
  set(key: string, value: unknown): void;

  /** Attach several attributes at once. */
  setAll(attrs: Record<string, unknown>): void;

  /**
   * Mark this span as deliberately not done — no search key, no hiring page, budget spent.
   * A skipped step is honest degradation, not a failure, and never throws.
   */
  skip(reason: string): void;

  /**
   * Run `fn` inside a child span of this one.
   *
   * Deviation from the original sketch, which had `child(step): SpanHandle`: a handle with no
   * scope has no defined end, so an unclosed child could leak into the trace. Passing the
   * function in makes the lifetime explicit and lets concurrent children parent correctly.
   */
  child<T>(step: string, fn: (s: SpanHandle) => Promise<T>): Promise<T>;
}

export interface Tracer {
  /**
   * Run `fn` inside a span. Nests automatically when called from inside another span, so a
   * step does not have to thread a parent handle through every helper it calls.
   *
   * A throwing `fn` records the span as `failed` and rethrows — tracing never swallows.
   */
  span<T>(step: string, fn: (s: SpanHandle) => Promise<T>): Promise<T>;

  /** Completed and in-flight spans, in start order. Safe to mutate; these are copies. */
  export(): Span[];
}
