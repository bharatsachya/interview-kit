import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "@trao/contracts";

export const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "sites");

/** Same virtual-time semantics as kernel's FixedClock; retrieval may only import contracts. */
export class TestClock implements Clock {
  #now: number;

  constructor(startAt = 0) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  async sleep(ms: number): Promise<void> {
    if (ms > 0) this.#now += ms;
  }
}
