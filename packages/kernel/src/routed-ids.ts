import type { IdGenerator } from "@trao/contracts";

/**
 * Routes ids by prefix to different generators.
 *
 * There are two kinds of id in this system and conflating them is a data-loss bug:
 *
 * - **Within a kit** — `r1`, `q1`, `f1`. Sequential, because they are read by humans in the
 *   trace and compared by snapshot tests. They only have to be unique inside one document.
 * - **Outliving the run** — kits, jobs, users. These are storage keys and must be globally
 *   unique.
 *
 * A single `SequentialIdGenerator` for both means every run produces `kit_1`, and the second
 * user's kit silently overwrites the first user's in the store. That is exactly what happened
 * once the API started building a fresh generator per job, and it is the kind of fault that
 * looks like a caching problem for an hour.
 */
export class RoutedIdGenerator implements IdGenerator {
  constructor(
    private readonly fallback: IdGenerator,
    private readonly byPrefix: Readonly<Record<string, IdGenerator>>,
  ) {}

  next(prefix: string): string {
    return (this.byPrefix[prefix] ?? this.fallback).next(prefix);
  }
}
