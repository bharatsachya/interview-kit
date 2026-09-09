import { KitError, type LlmProvider, type LlmRequest, type LlmResult, type Tracer } from "@trao/contracts";
import { estimateTokens } from "./tokens";
import { ProviderError, type ModelTransport, type ModelTransportRequest, type ModelTransportResponse } from "./transport";

/**
 * Canned, schema-valid responses keyed by purpose. Zero network, zero quota, zero latency.
 *
 * This is what `--fake-llm` uses, and it bypasses the gateway entirely rather than sitting
 * underneath it — the point is a full pipeline run in under a second, and there is nothing to
 * rate-limit when nothing leaves the process. Gateway behaviour is exercised by `FakeTransport`
 * instead, so both halves are covered without either slowing the other down.
 *
 * It validates its own canned response against the caller's schema and throws if it does not
 * fit. A fixture that has drifted from its schema should fail loudly here, in a fast test, and
 * not quietly at H8 against a real provider.
 */

export interface RecordedCall {
  purpose: string;
  prompt: string;
  tier: string;
}

/** A response computed from the request, for when the canned value depends on the prompt. */
export type FakeResponder = (request: LlmRequest<unknown>) => unknown;

/**
 * Note the two are kept separate rather than unioned. `unknown | Responder` collapses to plain
 * `unknown`, which silently destroys parameter inference at every call site.
 */
export type FakeResponse = unknown;

export interface FakeLlmProviderOptions {
  /** Keyed by `LlmRequest.purpose`. Values may be plain data or a `FakeResponder`. */
  responses?: Record<string, FakeResponse>;
  /**
   * Emit an `llm:<purpose>` span per call, matching the shape the real gateway emits.
   *
   * Bypassing the gateway is what makes fake runs fast, but it also means fake traces show no
   * model calls at all — so `--record-prompts` would silently record nothing and a fake trace
   * would look structurally different from a live one. With a tracer supplied, the two read the
   * same and the trace viewer needs no special case.
   */
  tracer?: Tracer;
  recordPrompts?: boolean;
}

export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake";
  readonly calls: RecordedCall[] = [];
  readonly #responses = new Map<string, FakeResponse>();
  readonly #tracer: Tracer | undefined;
  readonly #recordPrompts: boolean;

  constructor(options: FakeLlmProviderOptions = {}) {
    for (const [purpose, response] of Object.entries(options.responses ?? {})) {
      this.#responses.set(purpose, response);
    }
    this.#tracer = options.tracer;
    this.#recordPrompts = options.recordPrompts ?? false;
  }

  /**
   * Register or replace a canned response. Returns `this` so setup reads as one expression.
   *
   * Overloaded rather than taking a union: the responder signature has to come first so a
   * function literal gets its parameter inferred instead of landing on `unknown`.
   */
  respondWith(purpose: string, responder: FakeResponder): this;
  respondWith(purpose: string, value: FakeResponse): this;
  respondWith(purpose: string, response: unknown): this {
    this.#responses.set(purpose, response);
    return this;
  }

  callsFor(purpose: string): RecordedCall[] {
    return this.calls.filter((call) => call.purpose === purpose);
  }

  /** Every distinct prompt seen, for asserting the four question categories differ. */
  promptsFor(purpose: string): string[] {
    return this.callsFor(purpose).map((call) => call.prompt);
  }

  reset(): void {
    this.calls.length = 0;
  }

  /**
   * Exact match, then longest registered prefix.
   *
   * Purposes carry a suffix so each call gets its own trace span and cache key — a category on
   * question generation, the requirement ids on a gap fill. A fixture registered as `gap_fill`
   * should answer `gap_fill:r3+r6` without having to enumerate every possible combination.
   */
  #keyFor(purpose: string): string | null {
    if (this.#responses.has(purpose)) return purpose;

    let best: string | null = null;
    for (const key of this.#responses.keys()) {
      if (!purpose.startsWith(key)) continue;
      if (best === null || key.length > best.length) best = key;
    }
    return best;
  }

  complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    if (this.#tracer === undefined) return this.#answer(request);
    return this.#tracer.span(`llm:${request.purpose}`, async (span) => {
      const result = await this.#answer(request);
      span.setAll({
        model: "fake",
        cache_hit: false,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        attempt: 1,
        queued_ms: 0,
        rate_limited: false,
        repair_attempted: false,
        ...(this.#recordPrompts
          ? { prompt: request.prompt, response: JSON.stringify(result.data, null, 2) }
          : {}),
      });
      return result;
    });
  }

  async #answer<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push({ purpose: request.purpose, prompt: request.prompt, tier: request.tier ?? "fast" });

    const key = this.#keyFor(request.purpose);
    if (key === null) {
      throw new KitError(
        "INVALID_MODEL_OUTPUT",
        `FakeLlmProvider has no canned response for "${request.purpose}". ` +
          `Register one with respondWith(${JSON.stringify(request.purpose)}, …).`,
      );
    }

    const canned = this.#responses.get(key);
    const value =
      typeof canned === "function" ? (canned as FakeResponder)(request as LlmRequest<unknown>) : canned;

    const parsed = request.schema.safeParse(value);
    if (!parsed.success) {
      throw new KitError(
        "INVALID_MODEL_OUTPUT",
        `FakeLlmProvider's canned response for "${request.purpose}" does not match the schema: ${parsed.error.message}`,
      );
    }

    return {
      data: parsed.data,
      usage: { inputTokens: estimateTokens(request.prompt), outputTokens: estimateTokens(JSON.stringify(value)) },
      model: "fake",
      cacheHit: false,
      repaired: false,
    };
  }
}

/**
 * A scriptable transport, for testing the gateway itself.
 *
 * Each entry is either text to return or an error to throw, consumed in order; once the script
 * runs out the last entry repeats, so "always 429" is one entry rather than ten.
 */
export type ScriptedStep = string | ProviderError | Error | { text: string; usage: { inputTokens: number; outputTokens: number } };

export class FakeTransport implements ModelTransport {
  readonly name = "fake-transport";
  readonly requests: ModelTransportRequest[] = [];
  #index = 0;

  constructor(private readonly script: ScriptedStep[]) {
    if (script.length === 0) throw new Error("FakeTransport needs at least one scripted step");
  }

  get callCount(): number {
    return this.requests.length;
  }

  async send(request: ModelTransportRequest): Promise<ModelTransportResponse> {
    this.requests.push(request);
    const step = this.script[Math.min(this.#index, this.script.length - 1)] as ScriptedStep;
    this.#index += 1;

    if (step instanceof Error) throw step;
    if (typeof step === "string") return { text: step };
    return { text: step.text, usage: step.usage };
  }
}

/** Shorthand for the 429 case, since half the limiter tests need one. */
export function rateLimited(retryAfterMs?: number): ProviderError {
  return new ProviderError("429 Too Many Requests", {
    status: 429,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}
