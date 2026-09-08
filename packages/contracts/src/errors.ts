/**
 * The one error type the pipeline can act on.
 *
 * `code` is what reaches the batch output (Appendix B) and the UI. Message is for humans and
 * is never parsed. A step that fails for a reason not in this list is a bug, not a new code.
 */

export const KIT_ERROR_CODES = [
  /** The company site could not be retrieved at all. The only research failure that is fatal. */
  "COMPANY_UNREACHABLE",
  /** The model provider was unreachable, or gave up after the retry budget. */
  "LLM_UNAVAILABLE",
  /** The model returned something the schema rejected, twice. */
  "INVALID_MODEL_OUTPUT",
  /** Calls, tokens or wall-clock for this run are spent. */
  "BUDGET_EXHAUSTED",
  /** The submission itself is unusable — empty JD, malformed URL, days out of range. */
  "INVALID_INPUT",
  /** A produced kit failed Appendix A validation. Always our bug. */
  "KIT_VALIDATION_FAILED",
  /** A per-case or per-request deadline elapsed. */
  "TIMEOUT",
  /** Anything unclassified. */
  "INTERNAL",
] as const;

export type KitErrorCode = (typeof KIT_ERROR_CODES)[number];

export interface KitErrorOptions {
  /** Whether retrying the same call could plausibly succeed. Drives the backoff decision. */
  retryable?: boolean;
  cause?: unknown;
  /** Extra context for the trace. Never shown to a user. */
  details?: Record<string, unknown>;
}

export class KitError extends Error {
  readonly code: KitErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: KitErrorCode, message: string, options: KitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "KitError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export function isKitError(value: unknown): value is KitError {
  return value instanceof KitError;
}

/** Narrow an unknown thrown value to a code + message pair suitable for a span or a report. */
export function toErrorShape(value: unknown): { code: KitErrorCode | string; message: string } {
  if (isKitError(value)) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: value.name || "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: String(value) };
}
