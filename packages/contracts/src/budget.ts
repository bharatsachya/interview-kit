/**
 * Per-run spend limits.
 *
 * Steps check before spending. When the budget is gone the pipeline ships what it has with the
 * gaps recorded honestly — a partial kit is `ok`, only a kit that could not be produced at all
 * is `failed`.
 */

export interface BudgetLimits {
  maxCalls: number;
  maxTokens: number;
  /** Epoch milliseconds. Read from the Clock, never from Date.now(). */
  deadlineAt: number;
}

export interface BudgetSnapshot {
  callsUsed: number;
  tokensUsed: number;
  callsRemaining: number;
  tokensRemaining: number;
  msRemaining: number;
  exhausted: boolean;
}

export interface Budget {
  readonly limits: BudgetLimits;

  /** True when one more call of roughly this size still fits inside every limit. */
  canSpend(estimatedTokens: number): boolean;

  /** Record a spend. Throws `KitError("BUDGET_EXHAUSTED")` if there was nothing left. */
  spend(tokens: number): void;

  snapshot(): BudgetSnapshot;
}
