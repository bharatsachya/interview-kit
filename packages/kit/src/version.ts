import type { InternalKit } from "./types";

/**
 * A write that would have overwritten someone else's.
 *
 * Carries the version the document is actually on so the caller can refetch and rebase rather
 * than guess. `currentVersion` is snake_cased on the wire by the API layer; here it stays in the
 * house style, like every other internal field.
 */
export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT" as const;

  constructor(
    readonly currentVersion: number,
    readonly expectedVersion: number,
  ) {
    super(
      `This kit has changed since you loaded it — it is on version ${currentVersion}, not ${expectedVersion}.`,
    );
    this.name = "VersionConflictError";
  }
}

/** Options every mutation accepts. */
export interface MutationOptions {
  /**
   * The version the caller believes the kit is on.
   *
   * Optional because the pipeline and the batch script are the only writer in their process and
   * have nobody to race. Everything reaching the builder should pass it: leaving it out is not
   * "no opinion", it is "overwrite whatever is there".
   */
  ifVersion?: number;
}

/**
 * The one way a mutation is allowed to produce its result.
 *
 * Checking and bumping together is deliberate. Kept apart, a mutation can be written that checks
 * and forgets to bump — and a mutation that does not bump is invisible to the next writer's
 * check, which is the whole failure this exists to prevent.
 */
export function commit(
  kit: InternalKit,
  options: MutationOptions | undefined,
  changes: Partial<InternalKit>,
): InternalKit {
  const expected = options?.ifVersion;
  if (expected !== undefined && expected !== kit.version) {
    throw new VersionConflictError(kit.version, expected);
  }
  return { ...kit, ...changes, version: kit.version + 1 };
}
