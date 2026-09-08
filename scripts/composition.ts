import { resolve } from "node:path";
import type { Budget, Clock, HttpFetcher, IdGenerator, LlmProvider, SearchProvider, Tracer } from "@trao/contracts";
import { InMemoryTracer, RandomIdGenerator, SequentialIdGenerator, SystemClock } from "@trao/kernel";
import {
  FakeLlmProvider,
  LlmGateway,
  MemoryCacheStore,
  NullCacheStore,
  RunBudget,
  unlimitedBudget,
} from "@trao/llm";
import { NullSearchProvider, TavilySearchProvider } from "@trao/research";
import { FakeFetcher, LiveHttpFetcher, fixtureMounts } from "@trao/retrieval";
import { GeminiTransport } from "@trao/llm";
import { fakeLlmResponses, gapFillResponse } from "../fixtures/fake-llm-responses";

/**
 * Adapter construction, shared by `dev.ts` and `evaluate.ts`.
 *
 * These two scripts and `apps/api/main.ts` are the only files in the repo permitted to build an
 * adapter. Everything else receives what it needs as an argument, which is why the domain
 * packages have no way to reach a provider even by accident.
 *
 * The two scripts share this file rather than each wiring their own, so a flag cannot mean one
 * thing in the dev runner and another in the batch run.
 */

export interface WiringOptions {
  fakeLlm?: boolean;
  fakeFetch?: boolean;
  noCache?: boolean;
  allowPrivateHosts?: boolean;
  /** Per-run limits. Omitted means unlimited, which is what the dev runner wants. */
  budget?: { maxCalls: number; maxTokens: number; timeoutMs: number };
  /** Deterministic ids, so a fake run produces a byte-identical kit each time. */
  deterministicIds?: boolean;
}

export interface Wiring {
  llm: LlmProvider;
  fetcher: HttpFetcher;
  search: SearchProvider;
  tracer: Tracer;
  clock: Clock;
  ids: IdGenerator;
  budget: Budget;
  /** What was actually wired, for the run banner. Honest about what is fake. */
  describe: string[];
}

export const FIXTURE_ROOT = resolve(process.cwd(), "fixtures", "sites");

export function wire(options: WiringOptions = {}): Wiring {
  const clock = new SystemClock();
  const tracer = new InMemoryTracer(clock);
  const describe: string[] = [];

  const ids: IdGenerator = options.deterministicIds === true ? new SequentialIdGenerator() : new RandomIdGenerator();

  const budget: Budget =
    options.budget === undefined
      ? unlimitedBudget(clock)
      : new RunBudget(
          {
            maxCalls: options.budget.maxCalls,
            maxTokens: options.budget.maxTokens,
            deadlineAt: clock.now() + options.budget.timeoutMs,
          },
          clock,
        );

  // ── The model ──────────────────────────────────────────────────────────────────────────
  let llm: LlmProvider;
  if (options.fakeLlm === true) {
    const fake = new FakeLlmProvider({ responses: fakeLlmResponses() });
    fake.respondWith("gap_fill", gapFillResponse);
    llm = fake;
    describe.push("llm: FakeLlmProvider (no network, no quota)");
  } else {
    const apiKey = process.env["GEMINI_API_KEY"] ?? "";
    if (apiKey === "") {
      throw new Error("GEMINI_API_KEY is not set. Use --fake-llm to run without a key, or see .env.example.");
    }
    llm = new LlmGateway({
      transport: new GeminiTransport({ apiKey }),
      cache: options.noCache === true ? new NullCacheStore() : new MemoryCacheStore(clock),
      clock,
      tracer,
      budget,
      models: {
        // Extraction is worth 20 points and asks for `quality`. Everything else takes `fast`.
        quality: process.env["GEMINI_MODEL_QUALITY"] ?? "gemini-2.5-flash",
        fast: process.env["GEMINI_MODEL_FAST"] ?? "gemini-2.5-flash-lite",
      },
      requestsPerMinute: Number(process.env["GEMINI_RPM"] ?? 10),
      tokensPerMinute: Number(process.env["GEMINI_TPM"] ?? 250_000),
    });
    describe.push(`llm: Gemini via gateway${options.noCache === true ? " (cache bypassed)" : ""}`);
  }

  // ── Fetching ───────────────────────────────────────────────────────────────────────────
  let fetcher: HttpFetcher;
  if (options.fakeFetch === true) {
    fetcher = new FakeFetcher({ root: FIXTURE_ROOT, mounts: fixtureMounts() });
    describe.push(`fetch: FakeFetcher over ${FIXTURE_ROOT}`);
  } else {
    fetcher = new LiveHttpFetcher({ allowPrivateHosts: options.allowPrivateHosts === true });
    describe.push(`fetch: live${options.allowPrivateHosts === true ? " (ALLOW_PRIVATE_HOSTS=true)" : ""}`);
  }

  // ── Search: optional by design. No key degrades, it never throws. ──────────────────────
  const tavilyKey = process.env["TAVILY_API_KEY"] ?? "";
  const search: SearchProvider =
    tavilyKey === "" || options.fakeLlm === true
      ? new NullSearchProvider()
      : new TavilySearchProvider({ apiKey: tavilyKey });
  describe.push(`search: ${search.name}${search.name === "none" ? " (no TAVILY_API_KEY — step will be skipped)" : ""}`);

  return { llm, fetcher, search, tracer, clock, ids, budget, describe };
}
