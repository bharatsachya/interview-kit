import type { IdGenerator, LlmProvider, LlmRequest, LlmResult } from "@trao/contracts";

/**
 * A local fake provider. `extraction` may only import contracts and kit, so `@trao/llm`'s
 * FakeLlmProvider is out of reach — which is the dependency rule doing its job: extraction has
 * no way to reach a provider except the one handed to it.
 */
export class StubLlm implements LlmProvider {
  readonly name = "stub";
  readonly calls: { purpose: string; prompt: string; tier: string }[] = [];

  constructor(private readonly responses: Record<string, unknown>) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push({ purpose: request.purpose, prompt: request.prompt, tier: request.tier ?? "fast" });

    const canned = this.responses[request.purpose];
    if (canned === undefined) throw new Error(`StubLlm has no response for ${request.purpose}`);

    const parsed = request.schema.safeParse(canned);
    if (!parsed.success) throw new Error(`canned response invalid: ${parsed.error.message}`);

    return {
      data: parsed.data,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "stub",
      cacheHit: false,
      repaired: false,
    };
  }
}

export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}${n}`;
    },
  };
}

/** A realistic posting with the two headings the rubric cares about. */
export const RICH_JD = `Senior Backend Engineer
Acme Payments — Berlin (hybrid)

We move money for around 400 marketplaces and we are looking for a senior engineer to join
the ledger team.

Required:
- 5+ years building production services in Python
- Experience operating PostgreSQL at scale, including replication
- Designing distributed systems with clear availability trade-offs
- Mentoring junior engineers and reviewing their work
- A background in payments or another regulated domain

Nice to have:
- Kubernetes in production
- Experience with Kafka or a similar streaming platform
- Public speaking or writing about engineering

We interview in three stages and give a decision within a week.
`;

/** The two-line stub the brief tests against. Should produce few requirements and no inventions. */
export const STUB_JD = `Backend engineer needed. Must know Go.`;
