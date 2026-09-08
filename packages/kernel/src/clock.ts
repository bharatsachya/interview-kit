import type { Clock } from "@trao/contracts";

/** Wall-clock time. Used by everything outside tests. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Virtual time.
 *
 * `sleep` does not wait — it advances the clock and resolves on the next microtask. That is
 * what lets the rate limiter's queueing, exponential backoff and Retry-After handling be
 * asserted exactly, in milliseconds, instead of being approximated with real timers.
 *
 * Sleepers resume in wake-time order rather than call order, so a caller that asks for 5s does
 * not overtake one that asked for 1s a moment earlier.
 */
export class FixedClock implements Clock {
  #now: number;
  #pending: { wakeAt: number; seq: number; resolve: () => void }[] = [];
  #seq = 0;

  constructor(startAt = 0) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const wakeAt = this.#now + ms;
    return new Promise<void>((resolve) => {
      this.#pending.push({ wakeAt, seq: this.#seq++, resolve });
      // Nobody is driving virtual time from outside, so a sleep drives it itself. Tests that
      // want to interleave work at a specific instant call `advance` explicitly instead.
      queueMicrotask(() => this.advanceTo(wakeAt));
    });
  }

  /** Move time forward by `ms`, waking anything due. */
  advance(ms: number): void {
    this.advanceTo(this.#now + ms);
  }

  /** Move time forward to an absolute instant. Never moves backwards. */
  advanceTo(instant: number): void {
    if (instant <= this.#now) return;
    this.#now = instant;
    const due = this.#pending
      .filter((p) => p.wakeAt <= instant)
      .sort((a, b) => a.wakeAt - b.wakeAt || a.seq - b.seq);
    this.#pending = this.#pending.filter((p) => p.wakeAt > instant);
    for (const p of due) p.resolve();
  }

  /** Set the current instant outright. For arranging a test, not for use mid-run. */
  set(instant: number): void {
    this.#now = instant;
  }
}
