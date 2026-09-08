import { randomUUID } from "node:crypto";
import type { IdGenerator } from "@trao/contracts";

/**
 * `r1, r2, r3` per prefix.
 *
 * Requirement and question ids are read by humans in the trace and compared by tests, so they
 * are sequential rather than random even in production. Uniqueness only has to hold within one
 * kit, and it does — ids are never reused, because deletion is a flag, not a removal.
 */
export class SequentialIdGenerator implements IdGenerator {
  readonly #counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}${n}`;
  }
}

/**
 * Globally unique ids, for things that outlive a run — kits, jobs, users. A sequential
 * generator would collide across processes; batch mode runs cases concurrently.
 */
export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}${randomUUID().replaceAll("-", "")}`;
  }
}

/** Fixed, in order, then wraps. Only for tests that assert on an exact id. */
export class ScriptedIdGenerator implements IdGenerator {
  #index = 0;

  constructor(private readonly ids: readonly string[]) {
    if (ids.length === 0) throw new Error("ScriptedIdGenerator needs at least one id");
  }

  next(_prefix: string): string {
    const id = this.ids[this.#index % this.ids.length] as string;
    this.#index += 1;
    return id;
  }
}
