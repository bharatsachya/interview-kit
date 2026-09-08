/**
 * Exponential backoff with jitter.
 */

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injected so tests are deterministic. Nothing in the repo calls Math.random directly. */
  random?: () => number;
}

export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;

/**
 * Full jitter: a uniform draw from `[0, base × 2^(attempt-1)]`, capped.
 *
 * Jitter rather than a fixed schedule because the batch runner puts two or three cases in flight
 * at once against one shared quota. Undithered backoff would have them all sleep for the same
 * interval and then retry in the same instant, reproducing the burst that caused the 429.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const random = options.random ?? Math.random;

  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}

/**
 * How long to wait before retry `attempt`.
 *
 * `Retry-After` wins whenever the provider sends it: it is the only party that knows when the
 * quota window actually reopens, and guessing shorter just burns another request.
 */
export function retryDelay(attempt: number, retryAfterMs: number | undefined, options?: BackoffOptions): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return retryAfterMs;
  return backoffDelay(attempt, options);
}
