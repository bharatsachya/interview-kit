import type { Clock } from "@trao/contracts";

/**
 * A refilling token bucket, serialised.
 *
 * Two of these run in front of every call: requests per minute and tokens per minute. TPM is the
 * one people forget, and it is the one a long prompt trips first.
 *
 * Acquires are processed one at a time through an internal promise chain. Without that, two
 * concurrent callers both read `available`, both decide there is room, and both spend it — which
 * is exactly the 429 the bucket exists to avoid. Serialising is also what makes this a *queue*:
 * a request over the limit waits its turn rather than firing and failing.
 */
export class TokenBucket {
  #available: number;
  #lastRefillAt: number;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly capacity: number,
    /** How much the bucket refills per millisecond. `capacity / 60_000` for a per-minute limit. */
    readonly refillPerMs: number,
    private readonly clock: Clock,
  ) {
    this.#available = capacity;
    this.#lastRefillAt = clock.now();
  }

  /** Milliseconds this caller spent waiting. Reaches the trace as `queued_ms`. */
  acquire(tokens: number): Promise<number> {
    const result = this.#tail.then(() => this.#take(tokens));
    // Keep the chain alive whatever happens to this caller.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get available(): number {
    return this.#available;
  }

  async #take(tokens: number): Promise<number> {
    // A single request larger than the whole bucket can never be satisfied. Clamp rather than
    // deadlock — upstream truncation is what should have prevented it, and the provider will
    // say so if the request really is too big.
    const wanted = Math.min(Math.max(tokens, 0), this.capacity);
    const startedAt = this.clock.now();

    this.#refill();
    if (this.#available < wanted) {
      const deficit = wanted - this.#available;
      await this.clock.sleep(Math.ceil(deficit / this.refillPerMs));
      this.#refill();
    }

    this.#available = Math.max(0, this.#available - wanted);
    return this.clock.now() - startedAt;
  }

  #refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.#lastRefillAt;
    if (elapsed <= 0) return;
    this.#available = Math.min(this.capacity, this.#available + elapsed * this.refillPerMs);
    this.#lastRefillAt = now;
  }
}

/** Convenience for the usual "N per minute" shape. */
export function perMinute(capacity: number, clock: Clock): TokenBucket {
  return new TokenBucket(capacity, capacity / 60_000, clock);
}
