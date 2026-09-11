/**
 * The internal seam to a model provider.
 *
 * `LlmProvider` in contracts is the seam the rest of the repo sees: give it a prompt and a
 * schema, get a parsed object. `ModelTransport` is the seam *inside* this package: raw text in,
 * raw text out, no retrying, no caching, no parsing. Everything interesting — buckets, queueing,
 * backoff, cache, JSON repair — lives in the gateway between the two, so there is exactly one
 * place to reason about it and exactly one place to test it.
 *
 * Two implementations: `FakeTransport` here, and the Gemini adapter at H8.
 */

export interface ModelTransportRequest {
  model: string;
  prompt: string;
  maxOutputTokens?: number;
  /**
   * Overrides the transport's own timeout for this request.
   *
   * The gateway sets it from the time left on the run: a request that cannot finish before the
   * deadline should not be started with a sixty-second budget it will never be allowed to use.
   */
  timeoutMs?: number;
}

export interface ModelTransportResponse {
  text: string;
  /** Real token counts when the provider reports them. The gateway estimates otherwise. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ModelTransport {
  /** Reaches the trace as the provider name. */
  readonly name: string;
  send(request: ModelTransportRequest): Promise<ModelTransportResponse>;
}

/**
 * What a transport throws. The gateway decides what to do with it; the transport never retries
 * on its own, because a retry the gateway did not schedule is a retry the token buckets did not
 * account for.
 */
export class ProviderError extends Error {
  readonly status: number | undefined;
  /** From the `Retry-After` header. Overrides the backoff schedule when the provider sends it. */
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;
  /**
   * This *model* cannot answer, as opposed to this request being wrong or the account being out
   * of quota — so a caller with another model configured should move on rather than fail.
   *
   * A status code alone cannot carry this. OpenRouter reports a free model that is retired or
   * out of capacity as HTTP 200 with `error.code: 429` in the body, which is indistinguishable
   * by status from an account-level rate limit that must be waited out instead. Only the
   * transport knows which of the two it is looking at, so it says so here.
   */
  readonly modelUnavailable: boolean;
  /**
   * The request asked for something this model cannot do, rather than being wrong.
   *
   * Narrow on purpose, and currently one thing: a provider rejecting `response_format` because
   * the model has no structured-output support. It arrives as a 400, which is otherwise exactly
   * the status that must never be retried — so the distinction has to be carried explicitly or
   * a usable model is discarded over an optimisation it never needed.
   */
  readonly unsupportedFeature: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      retryable?: boolean;
      modelUnavailable?: boolean;
      unsupportedFeature?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.modelUnavailable = options.modelUnavailable ?? false;
    this.unsupportedFeature = options.unsupportedFeature ?? false;
    // 429 and 5xx are worth waiting out. A 400 means the request itself is wrong and will be
    // wrong again in five seconds.
    this.retryable = options.retryable ?? isRetryableStatus(options.status);
  }
}

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // A network-level failure is worth one more try.
  return status === 408 || status === 429 || status >= 500;
}
