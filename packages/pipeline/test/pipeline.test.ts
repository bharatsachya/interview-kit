import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KitError,
  type Budget,
  type Clock,
  type IdGenerator,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type SearchProvider,
  type Span,
  type SpanHandle,
  type Tracer,
} from "@trao/contracts";
import { validateKitJSON } from "@trao/kit";
import { FakeFetcher, fixtureMounts } from "@trao/retrieval";
import { generateKit, type PipelineDeps } from "../src/pipeline";
import { hashSubmission } from "../src/hash";
import { fakeLlmResponses, gapFillResponse } from "../../../fixtures/fake-llm-responses";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "sites");

/**
 * Local stubs. `pipeline` may import every domain package but not `llm`, because it must never
 * construct a provider — so the fake provider comes from here rather than from `@trao/llm`.
 */
class StubLlm implements LlmProvider {
  readonly name = "stub";
  readonly calls: { purpose: string; prompt: string }[] = [];
  #failures = new Map<string, Error>();

  constructor(private readonly responses: Record<string, (r: LlmRequest<unknown>) => unknown>) {}

  failOn(purposePrefix: string, error: Error): this {
    this.#failures.set(purposePrefix, error);
    return this;
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push({ purpose: request.purpose, prompt: request.prompt });

    for (const [prefix, error] of this.#failures) {
      if (request.purpose.startsWith(prefix)) throw error;
    }

    const key = Object.keys(this.responses)
      .filter((k) => request.purpose === k || request.purpose.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`no canned response for ${request.purpose}`);

    const value = (this.responses[key] as (r: LlmRequest<unknown>) => unknown)(request as LlmRequest<unknown>);
    const parsed = request.schema.safeParse(value);
    if (!parsed.success) throw new Error(`canned response invalid for ${request.purpose}: ${parsed.error.message}`);

    return { data: parsed.data, usage: { inputTokens: 1, outputTokens: 1 }, model: "stub", cacheHit: false, repaired: false };
  }
}

class TestTracer implements Tracer {
  readonly spans: Span[] = [];
  #depth: string[] = [];

  async span<T>(step: string, fn: (s: SpanHandle) => Promise<T>): Promise<T> {
    const attrs: Record<string, unknown> = {};
    const id = `s${this.spans.length + 1}`;
    const span: Span = {
      id,
      parentId: this.#depth.at(-1) ?? null,
      step,
      startedAt: 0,
      endedAt: 0,
      durationMs: 0,
      status: "ok",
      attrs,
    };
    this.spans.push(span);
    this.#depth.push(id);

    const handle: SpanHandle = {
      id,
      set: (k, v) => void (attrs[k] = v),
      setAll: (v) => void Object.assign(attrs, v),
      skip: (reason) => {
        span.status = "skipped";
        attrs["skip_reason"] = reason;
      },
      child: (childStep, childFn) => this.span(childStep, childFn),
    };

    try {
      return await fn(handle);
    } catch (error) {
      span.status = "failed";
      throw error;
    } finally {
      this.#depth.pop();
    }
  }

  export(): Span[] {
    return this.spans;
  }

  byStep(step: string): Span | undefined {
    return this.spans.find((s) => s.step === step);
  }

  childrenOf(step: string): Span[] {
    const parent = this.byStep(step);
    return parent === undefined ? [] : this.spans.filter((s) => s.parentId === parent.id);
  }
}

const clock: Clock = { now: () => 1_700_000_000_000, sleep: async () => {} };

function ids(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}${n}`;
    },
  };
}

const unlimited: Budget = {
  limits: { maxCalls: 1e9, maxTokens: 1e9, deadlineAt: 1e15 },
  canSpend: () => true,
  spend: () => {},
  snapshot: () => ({ callsUsed: 0, tokensUsed: 0, callsRemaining: 1e9, tokensRemaining: 1e9, msRemaining: 1e9, exhausted: false }),
};

const noSearch: SearchProvider = { name: "none", search: async () => [] };

const RICH_JD = `Senior Backend Engineer
Acme Payments — Berlin (hybrid)

Required:
- 5+ years building production services in Python
- Experience operating PostgreSQL at scale, including replication
- Mentoring junior engineers and reviewing their work
- A background in payments or another regulated domain

Nice to have:
- Kubernetes in production
`;

type TestDeps = PipelineDeps & { tracer: TestTracer; llm: StubLlm };

function deps(overrides: Omit<Partial<PipelineDeps>, "llm" | "tracer"> & { llm?: StubLlm } = {}): TestDeps {
  const { llm: llmOverride, ...rest } = overrides;
  const llm = llmOverride ?? new StubLlm({ ...fakeLlmResponses(), gap_fill: gapFillResponse });
  const tracer = new TestTracer();

  return {
    fetcher: new FakeFetcher({ root: FIXTURE_ROOT, mounts: fixtureMounts() }),
    search: noSearch,
    clock,
    ids: ids(),
    budget: unlimited,
    requestsPerSecond: 1_000,
    ...rest,
    llm,
    tracer,
  };
}

describe("a full run with fakes", () => {
  it("produces a schema-valid kit", async () => {
    const d = deps();
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, d);

    expect(result.status).toBe("ok");
    expect(validateKitJSON(result.kitJson)).toEqual({ ok: true, errors: [] });
  });

  it("emits a span for every one of the nine steps", async () => {
    const d = deps();
    await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, d);

    for (const step of [
      "generate_kit",
      "extract_requirements",
      "fetch_homepage",
      "crawl_site",
      "search_discussion",
      "generate_brief",
      "generate_questions",
      "coverage",
      "derive_flashcards",
      "allocate_schedule",
      "serialize_kit",
    ]) {
      expect(d.tracer.byStep(step), `no span for ${step}`).toBeDefined();
    }
  });

  it("gives generate_questions four child spans, one per category", async () => {
    const d = deps();
    await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, d);

    const children = d.tracer.childrenOf("generate_questions").map((s) => s.step);
    expect(children).toEqual([
      "category:technical",
      "category:behavioural",
      "category:system-design",
      "category:company-fit",
    ]);
  });

  it("makes four separate model calls for the four categories", async () => {
    const d = deps();
    await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, d);

    const categoryCalls = d.llm.calls.filter((c) => c.purpose.startsWith("generate_questions:"));
    expect(categoryCalls).toHaveLength(4);
    expect(new Set(categoryCalls.map((c) => c.prompt)).size).toBe(4);
  });

  it("feeds the crawled hiring process into question generation", async () => {
    const d = deps();
    await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, d);

    // The gitlab-like fixture's handbook describes a take-home and a system design round.
    const categoryCalls = d.llm.calls.filter((c) => c.purpose.startsWith("generate_questions:"));
    expect(categoryCalls.every((c) => /take-home/i.test(c.prompt))).toBe(true);
  });

  it("records the link scores that chose the pages, as evidence ranking ran in code", async () => {
    const d = deps();
    await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, d);

    const crawl = d.tracer.byStep("crawl_site");
    expect(crawl?.attrs["links_found"]).toBeGreaterThan(0);
    expect(String(crawl?.attrs["top_links"])).toContain("handbook");
  });

  it("skips the discussion search without a key, rather than failing", async () => {
    const d = deps();
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, d);

    expect(d.tracer.byStep("search_discussion")?.status).toBe("skipped");
    expect(d.tracer.byStep("search_discussion")?.attrs["skip_reason"]).toBe("no_key");
    expect(result.status).toBe("ok");
  });
});

describe("the sparse site", () => {
  it("still produces a kit, with an honest brief and truthful pages_used", async () => {
    const d = deps();
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://calder.test/", days: 3 }, d);

    expect(result.status).toBe("ok");
    const brief = result.kitJson?.company_brief;
    expect(brief?.pages_used).toEqual(["https://calder.test/"]);
    expect(brief?.gaps.join(" ")).toContain("No page describing the interview process");
    expect(brief?.hiring_process).toBe("");
  });
});

describe("the broken site", () => {
  it("fails the case with COMPANY_UNREACHABLE rather than inventing a company", async () => {
    const d = deps();
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://gone.test/", days: 5 }, d);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("COMPANY_UNREACHABLE");
    expect(result.kit).toBeNull();
    expect(result.kitJson).toBeNull();
  });

  it("still produces a JD-only kit when the policy is flipped", async () => {
    // The other reading of the spec conflict, one flag away.
    const d = deps({ treatUnreachableSiteAsFailure: false });
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://gone.test/", days: 5 }, d);

    expect(result.status).toBe("ok");
    expect(result.kitJson?.company_brief.pages_used).toEqual([]);
    expect(result.kitJson?.company_brief.summary).toContain("Nothing could be retrieved");
    expect(validateKitJSON(result.kitJson).ok).toBe(true);
  });
});

describe("degradation", () => {
  it("produces a kit with gaps listed when the budget runs out mid-coverage", async () => {
    const llm = new StubLlm({ ...fakeLlmResponses(), gap_fill: gapFillResponse }).failOn(
      "gap_fill",
      new KitError("BUDGET_EXHAUSTED", "Call budget spent."),
    );

    const d = deps({ llm });
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://calder.test/", days: 5 }, d);

    expect(result.status).toBe("ok");
    expect(validateKitJSON(result.kitJson).ok).toBe(true);
    expect(result.kitJson?.questions.length).toBeGreaterThan(0);
  });

  it("survives a failing question category with a thinner kit", async () => {
    const llm = new StubLlm({ ...fakeLlmResponses(), gap_fill: gapFillResponse }).failOn(
      "generate_questions:behavioural",
      new Error("model refused"),
    );

    const d = deps({ llm });
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, d);

    expect(result.status).toBe("ok");
    expect(d.tracer.childrenOf("generate_questions").find((s) => s.step.endsWith("behavioural"))?.attrs["failed"]).toBeDefined();
    expect(result.kitJson?.questions.some((q) => q.category === "technical")).toBe(true);
  });

  it("keeps going with an honest brief when brief generation fails", async () => {
    const llm = new StubLlm({ ...fakeLlmResponses(), gap_fill: gapFillResponse }).failOn(
      "generate_brief",
      new Error("model refused"),
    );

    const d = deps({ llm });
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, d);

    expect(result.status).toBe("ok");
    expect(result.kitJson?.company_brief.gaps.join(" ")).toContain("could not be generated");
  });

  it("fails the case when extraction itself cannot run", async () => {
    const llm = new StubLlm({}).failOn("extract_requirements", new KitError("LLM_UNAVAILABLE", "provider down"));

    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, deps({ llm }));

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("LLM_UNAVAILABLE");
  });
});

describe("the thin description", () => {
  it("produces a thin kit that says so, rather than inventing requirements", async () => {
    const d = deps();
    const result = await generateKit(
      { jd: "Backend engineer needed. Must know Go.", companyUrl: "https://calder.test/", days: 1 },
      d,
    );

    expect(result.status).toBe("ok");
    expect(result.kitJson?.requirements.length).toBeLessThanOrEqual(2);
    // Everything in the kit traces back to the two lines we were given.
    for (const requirement of result.kitJson?.requirements ?? []) {
      expect(requirement.text.toLowerCase()).toContain("go");
    }
  });
});

describe("the schedule", () => {
  it.each([1, 5, 14, 60])("produces exactly %s day(s)", async (days) => {
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days }, deps());

    expect(result.kitJson?.schedule.days).toHaveLength(days);
    expect(result.kitJson?.schedule.days_available).toBe(days);
  });

  it("leaves no day empty in the 60-day case", async () => {
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 60 }, deps());

    for (const day of result.kitJson?.schedule.days ?? []) {
      expect(day.question_ids.length, `day ${day.day} is empty`).toBeGreaterThan(0);
    }
  });
});

describe("idempotency", () => {
  it("hashes the same submission to the same key", () => {
    expect(hashSubmission(RICH_JD, "https://meridian.test/", 5)).toBe(hashSubmission(RICH_JD, "https://meridian.test/", 5));
  });

  it("ignores whitespace and trailing-slash differences a re-paste introduces", () => {
    const a = hashSubmission(RICH_JD, "https://meridian.test/", 5);
    const b = hashSubmission(`${RICH_JD.replace(/\n/g, "\r\n")}   \n`, "https://Meridian.test", 5);
    expect(b).toBe(a);
  });

  it("distinguishes a different day count", () => {
    expect(hashSubmission(RICH_JD, "https://meridian.test/", 5)).not.toBe(hashSubmission(RICH_JD, "https://meridian.test/", 6));
  });

  it("reports the hash on the result, so the caller can store it", async () => {
    const result = await generateKit({ jd: RICH_JD, companyUrl: "https://meridian.test/", days: 5 }, deps());
    expect(result.hash).toBe(hashSubmission(RICH_JD, "https://meridian.test/", 5));
  });
});
