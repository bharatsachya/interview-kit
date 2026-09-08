/**
 * Clock and IdGenerator.
 *
 * These exist purely so the output is deterministic under test. Without a fixed clock the
 * schedule and rate-limiter tests are flaky; without fixed ids no kit snapshot ever matches.
 * Nothing in the repo may call `Date.now()`, `new Date()`, `setTimeout` or `crypto.randomUUID`
 * directly — it takes a Clock or an IdGenerator instead.
 */

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;

  /**
   * Wait. On the fake clock this advances virtual time and resolves immediately, which is what
   * makes the rate limiter's backoff and Retry-After tests run in milliseconds instead of
   * minutes.
   */
  sleep(ms: number): Promise<void>;
}

export interface IdGenerator {
  /**
   * Next id for a prefix. Counters are kept per prefix, so requirements read `r1, r2, r3`
   * and questions read `q1, q2, q3` in the same run.
   */
  next(prefix: string): string;
}
