import { KitError, type Budget, type BudgetLimits, type BudgetSnapshot, type Clock } from "@trao/contracts";

/**
 * Per-run spend limits: calls, tokens, and wall-clock.
 *
 * Wall-clock is in there because the batch harness gives five cases fifteen minutes. A case that
 * has not finished by its deadline has to ship what it has — a partial kit is `ok`, and a case
 * that eats the whole window so the other four fail is not.
 */
export class RunBudget implements Budget {
  #callsUsed = 0;
  #tokensUsed = 0;

  constructor(
    readonly limits: BudgetLimits,
    private readonly clock: Clock,
  ) {}

  canSpend(estimatedTokens: number): boolean {
    if (this.#callsUsed >= this.limits.maxCalls) return false;
    if (this.#tokensUsed + estimatedTokens > this.limits.maxTokens) return false;
    return this.clock.now() < this.limits.deadlineAt;
  }

  spend(tokens: number): void {
    if (!this.canSpend(tokens)) {
      throw new KitError("BUDGET_EXHAUSTED", this.#describe(tokens), { details: { ...this.snapshot() } });
    }
    this.#callsUsed += 1;
    this.#tokensUsed += tokens;
  }

  snapshot(): BudgetSnapshot {
    const msRemaining = Math.max(0, this.limits.deadlineAt - this.clock.now());
    return {
      callsUsed: this.#callsUsed,
      tokensUsed: this.#tokensUsed,
      callsRemaining: Math.max(0, this.limits.maxCalls - this.#callsUsed),
      tokensRemaining: Math.max(0, this.limits.maxTokens - this.#tokensUsed),
      msRemaining,
      exhausted: this.#callsUsed >= this.limits.maxCalls || msRemaining === 0,
    };
  }

  /** Says which limit ran out, because "budget exhausted" alone is not actionable in a trace. */
  #describe(tokens: number): string {
    if (this.#callsUsed >= this.limits.maxCalls) {
      return `Call budget spent: ${this.#callsUsed}/${this.limits.maxCalls} calls.`;
    }
    if (this.#tokensUsed + tokens > this.limits.maxTokens) {
      return `Token budget spent: ${this.#tokensUsed}+${tokens} would exceed ${this.limits.maxTokens}.`;
    }
    return `Deadline passed ${this.clock.now() - this.limits.deadlineAt}ms ago.`;
  }
}

/** A budget that never runs out. For the dev runner and for tests that are not about budgets. */
export function unlimitedBudget(clock: Clock): Budget {
  return new RunBudget(
    { maxCalls: Number.MAX_SAFE_INTEGER, maxTokens: Number.MAX_SAFE_INTEGER, deadlineAt: Number.MAX_SAFE_INTEGER },
    clock,
  );
}
