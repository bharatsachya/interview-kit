import { AsyncLocalStorage } from "node:async_hooks";
import type { LlmProvider, LlmRequest, LlmResult, Span, SpanHandle, Tracer } from "@trao/contracts";

/**
 * Local stubs. `pipeline` may import every domain package but not `llm`, because it must never
 * construct a provider — so the fake provider comes from here rather than from `@trao/llm`.
 */
export class StubLlm implements LlmProvider {
  readonly name = "stub";
  readonly calls: { purpose: string; prompt: string }[] = [];
  #failures = new Map<string, Error>();
  #tracer: Tracer | undefined;

  constructor(private readonly responses: Record<string, (r: LlmRequest<unknown>) => unknown>) {}

  /** Emit `llm:<purpose>` spans the way the real gateway does, so nesting can be asserted. */
  tracing(tracer: Tracer): this {
    this.#tracer = tracer;
    return this;
  }

  failOn(purposePrefix: string, error: Error): this {
    this.#failures.set(purposePrefix, error);
    return this;
  }

  complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    if (this.#tracer === undefined) return this.#answer(request);
    return this.#tracer.span(`llm:${request.purpose}`, () => this.#answer(request));
  }

  async #answer<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push({ purpose: request.purpose, prompt: request.prompt });

    for (const [prefix, error] of this.#failures) {
      if (request.purpose.startsWith(prefix)) throw error;
    }

    const key = Object.keys(this.responses)
      .filter((k) => request.purpose === k || request.purpose.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`no canned response for ${request.purpose}`);

    const value = (this.responses[key] as (r: LlmRequest<unknown>) => unknown)(request as LlmRequest<unknown>);
    const parsed = request.schema.safeParse(value);
    if (!parsed.success) throw new Error(`canned response invalid for ${request.purpose}: ${parsed.error.message}`);

    return { data: parsed.data, usage: { inputTokens: 1, outputTokens: 1 }, model: "stub", cacheHit: false, repaired: false };
  }
}

/**
 * Parents spans through AsyncLocalStorage, exactly as `InMemoryTracer` does.
 *
 * It used a depth stack, which is correct only while spans nest strictly. The moment the four
 * question categories began running concurrently, their pushes and pops interleaved and three of
 * the four were attributed to the wrong parent — the test failed while the code was right. A
 * double that models concurrency differently from the real thing tests the double.
 */
export class TestTracer implements Tracer {
  readonly spans: Span[] = [];
  readonly #currentSpanId = new AsyncLocalStorage<string>();
  /** Monotonic, so "this span started before that one" is a real assertion. */
  #tick = 0;

  async span<T>(step: string, fn: (s: SpanHandle) => Promise<T>): Promise<T> {
    const attrs: Record<string, unknown> = {};
    const id = `s${this.spans.length + 1}`;
    const startedAt = (this.#tick += 1);
    const span: Span = {
      id,
      parentId: this.#currentSpanId.getStore() ?? null,
      step,
      startedAt,
      endedAt: startedAt,
      durationMs: 0,
      status: "running",
      attrs,
    };
    this.spans.push(span);

    const handle: SpanHandle = {
      id,
      set: (k, v) => void (attrs[k] = v),
      setAll: (v) => void Object.assign(attrs, v),
      skip: (reason) => {
        span.status = "skipped";
        attrs["skip_reason"] = reason;
      },
      child: (childStep, childFn) => this.span(childStep, childFn),
    };

    try {
      const result = await this.#currentSpanId.run(id, () => fn(handle));
      if (span.status === "running") span.status = "ok";
      return result;
    } catch (error) {
      span.status = "failed";
      throw error;
    } finally {
      span.endedAt = (this.#tick += 1);
      span.durationMs = span.endedAt - span.startedAt;
    }
  }

  export(): Span[] {
    return this.spans;
  }

  byStep(step: string): Span | undefined {
    return this.spans.find((s) => s.step === step);
  }

  childrenOf(step: string): Span[] {
    const parent = this.byStep(step);
    return parent === undefined ? [] : this.spans.filter((s) => s.parentId === parent.id);
  }

  allByStep(predicate: (step: string) => boolean): Span[] {
    return this.spans.filter((s) => predicate(s.step));
  }

  parentOf(span: Span): Span | undefined {
    return this.spans.find((s) => s.id === span.parentId);
  }
}
