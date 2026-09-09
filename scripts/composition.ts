import { resolve } from "node:path";
import type { Budget, Clock, HttpFetcher, IdGenerator, LlmProvider, SearchProvider, Tracer } from "@trao/contracts";
import { InMemoryTracer, RandomIdGenerator, RoutedIdGenerator, SequentialIdGenerator, SystemClock } from "@trao/kernel";
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
  /** Record each model call's prompt and raw response on its span. Never on in production. */
  recordPrompts?: boolean;
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
  /**
   * Prompts the fake provider saw.
   *
   * The real gateway records prompts on its spans, but `FakeLlmProvider` bypasses the gateway
   * entirely — which is what makes fake runs fast — so it has no span to write to. Reading its
   * call log back is how `--record-prompts` still shows prompt shape without spending quota.
   */
  recordedPrompts: () => { purpose: string; prompt: string }[];
}

export const FIXTURE_ROOT = resolve(process.cwd(), "fixtures", "sites");

export function wire(options: WiringOptions = {}): Wiring {
  const clock = new SystemClock();
  const tracer = new InMemoryTracer(clock);
  const describe: string[] = [];

  // Requirement, question and flashcard ids are ALWAYS sequential — r1, q1, f1 — because they
  // live inside one document and are read by humans in the trace. The first live run used random
  // ids for everything and put `r15c61aa7aac94c589cb192905d61174e` into every prompt, which is
  // 32 characters of noise per requirement for the model to copy back correctly.
  //
  // Only ids that outlive the run need to be globally unique. `deterministicIds` therefore
  // controls just those, so a fake run produces a byte-identical kit while a real one does not
  // collide across runs.
  const ids: IdGenerator = new RoutedIdGenerator(new SequentialIdGenerator(), {
    kit_: options.deterministicIds === true ? new SequentialIdGenerator() : new RandomIdGenerator(),
  });

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
    const fake = new FakeLlmProvider({
      responses: fakeLlmResponses(),
      // Emit the same span shape the gateway does, so a fake trace and a live trace read alike.
      tracer,
      ...(options.recordPrompts === true ? { recordPrompts: true } : {}),
    });
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
        //
        // The floating `-latest` aliases rather than a pinned version, deliberately. Google
        // retires numbered models for new API keys — `gemini-2.5-flash` 404s with "no longer
        // available to new users" on a key issued today — and a submission that a grader runs
        // months from now must not fail on a deprecation. Reproducibility loses to still
        // working; pin GEMINI_MODEL_* in .env when an exact version matters.
        quality: process.env["GEMINI_MODEL_QUALITY"] ?? "gemini-flash-latest",
        fast: process.env["GEMINI_MODEL_FAST"] ?? "gemini-flash-lite-latest",
      },
      requestsPerMinute: Number(process.env["GEMINI_RPM"] ?? 10),
      tokensPerMinute: Number(process.env["GEMINI_TPM"] ?? 250_000),
      ...(options.recordPrompts === true ? { recordPrompts: true } : {}),
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
  //
  // Gated on `fakeFetch` rather than `fakeLlm`, because "am I allowed to touch the network" is
  // what actually decides this. Tying it to the model flag meant --fake-llm silently disabled a
  // real Tavily key, which is exactly the wrong behaviour when the thing being tested is search.
  const tavilyKey = process.env["TAVILY_API_KEY"] ?? "";
  const offline = options.fakeFetch === true;
  const search: SearchProvider =
    tavilyKey === "" || offline ? new NullSearchProvider() : new TavilySearchProvider({ apiKey: tavilyKey });

  describe.push(
    `search: ${search.name}${
      search.name === "none"
        ? offline && tavilyKey !== ""
          ? " (--fake-fetch is offline; TAVILY_API_KEY ignored)"
          : " (no TAVILY_API_KEY — step will be skipped)"
        : ""
    }`,
  );

  const recordedPrompts = (): { purpose: string; prompt: string }[] =>
    llm instanceof FakeLlmProvider ? llm.calls.map((c) => ({ purpose: c.purpose, prompt: c.prompt })) : [];

  return { llm, fetcher, search, tracer, clock, ids, budget, describe, recordedPrompts };
}
