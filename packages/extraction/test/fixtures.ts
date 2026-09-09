import { readFileSync } from "node:fs";
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

/**
 * The real posting that produced the failure this package was rewritten for.
 *
 * 1,829 characters, and the first live run turned it into twenty requirements, all `must`,
 * six of which were the names of chat and file products the *company's* agent connects to.
 * Read from the fixture the dev runner and the batch cases use, so a test and a real
 * `--fake-llm` run are looking at the same bytes.
 */
export const MAGICA_JD = readFileSync(
  new URL("../../../fixtures/jds/magica-software-engineer.txt", import.meta.url),
  "utf8",
);

/** The six names that must never be requirements of their own. They describe the product. */
export const MAGICA_INTEGRATIONS = ["Gmail", "Drive", "Slack", "WhatsApp", "Telegram", "iMessage"];

/**
 * What the two-pile prompt gets back, model leakage included.
 *
 * The split works — the three "what you ship" paragraphs land in `responsibilities` — but the
 * model still lists the six integration names individually, because a sentence containing six
 * proper nouns is very hard for a model not to enumerate. That last mile is the merge's job,
 * which is exactly why the rule is enforced in code and not only in the prompt.
 */
export const MAGICA_RESPONSE = {
  role: {
    title: "Software Engineer",
    company: "Magica",
    location: "",
    summary: "Building the platform where users give Magica work and watch it execute.",
  },
  responsibilities: [
    "You'll build the platform where users give Magica work and watch it execute.",
    "Orchestration UX — sub-agent state, streaming partial output, exposing memory, handling interrupts and approvals.",
    "Connected services — the surfaces that let users plug Gmail, Drive, Slack, and the rest of their stack into Magica.",
    "Channels — keeping the web experience consistent with Magica's presence on WhatsApp, Telegram, and iMessage.",
  ],
  requirements: [
    { text: "Gmail", kind: "technical", priority: "must" },
    { text: "Drive", kind: "technical", priority: "must" },
    { text: "Slack", kind: "technical", priority: "must" },
    { text: "WhatsApp", kind: "technical", priority: "must" },
    { text: "Telegram", kind: "technical", priority: "must" },
    { text: "iMessage", kind: "technical", priority: "must" },
    {
      text: "designing UI for a system whose behavior is probabilistic and asynchronous",
      kind: "technical",
      priority: "must",
    },
    { text: "You build with monitoring and evals in mind from day one", kind: "technical", priority: "must" },
    {
      text: "You stay oriented without waiting for documentation that doesn't exist",
      kind: "behavioural",
      priority: "must",
    },
    { text: "A portfolio of real things you've shipped", kind: "behavioural", priority: "must" },
    {
      text: "Ability to take an ambiguous spec, scope it, and ship something usable in days",
      kind: "behavioural",
      priority: "must",
    },
    { text: "Prior work on AI or agent products", kind: "domain", priority: "must" },
  ],
};

/**
 * The pre-fix output, reconstructed: no piles at all, every noun in the posting a requirement.
 *
 * Kept as a regression fixture because the prompt is the only thing standing between us and it
 * again. What the code can still do on its own — collapse the example lists, and refuse to let
 * six product names become six study topics — is what the test against this asserts.
 */
export const MAGICA_OVER_SPLIT_RESPONSE = {
  role: { title: "Software Engineer", company: "Magica", location: "", summary: "" },
  requirements: [
    { text: "sub-agent state", kind: "technical", priority: "must" },
    { text: "streaming partial output", kind: "technical", priority: "must" },
    { text: "exposing memory", kind: "technical", priority: "must" },
    { text: "handling interrupts and approvals", kind: "technical", priority: "must" },
    { text: "Gmail", kind: "technical", priority: "must" },
    { text: "Drive", kind: "technical", priority: "must" },
    { text: "Slack", kind: "technical", priority: "must" },
    { text: "WhatsApp", kind: "technical", priority: "must" },
    { text: "Telegram", kind: "technical", priority: "must" },
    { text: "iMessage", kind: "technical", priority: "must" },
    {
      text: "designing UI for a system whose behavior is probabilistic and asynchronous",
      kind: "technical",
      priority: "must",
    },
    { text: "monitoring and evals", kind: "technical", priority: "must" },
    { text: "Refactors and migrations", kind: "technical", priority: "must" },
    { text: "A portfolio of real things you've shipped", kind: "behavioural", priority: "must" },
    {
      text: "Ability to take an ambiguous spec, scope it, and ship something usable in days",
      kind: "behavioural",
      priority: "must",
    },
    { text: "Prior work on AI or agent products", kind: "domain", priority: "must" },
  ],
};
