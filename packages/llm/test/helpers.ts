import type { OutputSchema, Span, SpanHandle, Tracer } from "@trao/contracts";

/**
 * A tracer for tests.
 *
 * `@trao/llm` may only import `contracts`, so it cannot reach `kernel`'s `InMemoryTracer` — and
 * the gateway takes a `Tracer` as a required argument on purpose, because `cache_hit` and
 * `queued_ms` are the two attributes you actually stare at while tuning the limiter. This
 * records flat spans, which is all these tests need to assert on.
 */
export class RecordingTracer implements Tracer {
  readonly spans: Span[] = [];

  async span<T>(step: string, fn: (s: SpanHandle) => Promise<T>): Promise<T> {
    const attrs: Record<string, unknown> = {};
    const span: Span = {
      id: `s${this.spans.length + 1}`,
      parentId: null,
      step,
      startedAt: 0,
      endedAt: 0,
      durationMs: 0,
      status: "ok",
      attrs,
    };
    this.spans.push(span);

    const handle: SpanHandle = {
      id: span.id,
      set: (key, value) => {
        attrs[key] = value;
      },
      setAll: (values) => Object.assign(attrs, values),
      skip: (reason) => {
        span.status = "skipped";
        attrs["skip_reason"] = reason;
      },
      child: (childStep, childFn) => this.span(childStep, childFn),
    };

    try {
      return await fn(handle);
    } catch (error) {
      span.status = "failed";
      throw error;
    }
  }

  export(): Span[] {
    return this.spans;
  }

  /** Attributes of the last span recorded. */
  get lastAttrs(): Record<string, unknown> {
    return (this.spans.at(-1) as Span).attrs;
  }
}

/**
 * A hand-written schema, so the gateway tests do not depend on Zod.
 *
 * It also proves `OutputSchema` is genuinely structural — anything with a `safeParse` works, not
 * just a Zod object.
 */
export function shapeSchema<T>(check: (value: unknown) => value is T, description: string): OutputSchema<T> {
  return {
    safeParse: (input) =>
      check(input) ? { success: true, data: input } : { success: false, error: { message: `expected ${description}` } },
  };
}

export interface Greeting {
  greeting: string;
}

export const greetingSchema = shapeSchema<Greeting>(
  (value): value is Greeting =>
    typeof value === "object" && value !== null && typeof (value as Greeting).greeting === "string",
  "{ greeting: string }",
);
