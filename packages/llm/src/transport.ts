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

  constructor(
    message: string,
    options: { status?: number; retryAfterMs?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    // 429 and 5xx are worth waiting out. A 400 means the request itself is wrong and will be
    // wrong again in five seconds.
    this.retryable = options.retryable ?? isRetryableStatus(options.status);
  }
}

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // A network-level failure is worth one more try.
  return status === 408 || status === 429 || status >= 500;
}
