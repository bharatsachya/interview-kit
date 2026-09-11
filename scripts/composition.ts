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
import { DEFAULT_REQUEST_BUDGET_MS, GeminiTransport, OPENROUTER_FREE_MODELS, OpenRouterTransport, RoutedTransport } from "@trao/llm";
import type { ModelTransport } from "@trao/llm";
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

/**
 * Which provider to talk to.
 *
 * `LLM_PROVIDER` decides when both keys are present; otherwise whichever key exists wins. Two
 * providers rather than one because Gemini's free tier is a daily wall — spend it and waiting
 * minutes does nothing — and OpenRouter's free models draw on a different bucket, so an
 * exhausted quota stops being the end of the day.
 *
 * They are alternatives, not a chain: the gateway falls back between *models* within one
 * provider, not between providers. Cross-provider fallback would mean two rate-limit budgets and
 * two caches behind one gateway, which is a bigger change than it looks and is not needed to
 * keep working.
 */
function chooseProvider(): { transport: ModelTransport; quality: string[]; fast: string[]; label: string } {
  const geminiKey = process.env["GEMINI_API_KEY"] ?? "";
  const openRouterKey = process.env["OPENROUTER_API_KEY"] ?? "";
  const requested = (process.env["LLM_PROVIDER"] ?? "").trim().toLowerCase();

  const useOpenRouter =
    requested === "openrouter" || (requested === "" && geminiKey === "" && openRouterKey !== "");

  if (useOpenRouter) {
    if (openRouterKey === "") throw new Error("LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is not set.");
    const free = [...OPENROUTER_FREE_MODELS];
    return {
      transport: new OpenRouterTransport({
        apiKey: openRouterKey,
        appName: "Trao Interview Prep Kit",
        ...(process.env["OPENROUTER_APP_URL"] !== undefined ? { appUrl: process.env["OPENROUTER_APP_URL"] } : {}),
      }),
      // One list for both tiers: the free models are peers rather than a quality ladder, and
      // claiming otherwise in the wiring would be a fiction the trace would then repeat.
      quality: modelList("OPENROUTER_MODELS", free),
      fast: modelList("OPENROUTER_MODELS", free),
      label: "OpenRouter (free models)",
    };
  }

  if (geminiKey === "") {
    throw new Error(
      "No model key. Set GEMINI_API_KEY or OPENROUTER_API_KEY in .env, or use --fake-llm to run without one.",
    );
  }

  // Both keys and no explicit choice: both providers, Gemini first. Mirrors apps/api — see the
  // longer note there. Batch wants it more than the app does, not less: five cases is thirty-odd
  // calls, which is several times Gemini's daily cap, so a run pinned to Gemini alone stops
  // partway through and reports failures that are about quota rather than about the pipeline.
  if (requested === "" && openRouterKey !== "") {
    const gemini = new GeminiTransport({ apiKey: geminiKey });
    const openRouter = new OpenRouterTransport({
      apiKey: openRouterKey,
      appName: "Trao Interview Prep Kit",
      ...(process.env["OPENROUTER_APP_URL"] !== undefined ? { appUrl: process.env["OPENROUTER_APP_URL"] } : {}),
    });
    const free = modelList("OPENROUTER_MODELS", [...OPENROUTER_FREE_MODELS]).map((m) => `openrouter:${m}`);
    const chain = [...modelList("GEMINI_MODEL_FAST", GEMINI_FAST).map((m) => `gemini:${m}`), ...free];

    return {
      transport: new RoutedTransport({ gemini, openrouter: openRouter }),
      quality: [...modelList("GEMINI_MODEL_QUALITY", GEMINI_QUALITY).map((m) => `gemini:${m}`), ...free],
      fast: chain,
      label: "Gemini → OpenRouter",
    };
  }

  return {
    transport: new GeminiTransport({ apiKey: geminiKey }),
    quality: modelList("GEMINI_MODEL_QUALITY", GEMINI_QUALITY),
    fast: modelList("GEMINI_MODEL_FAST", GEMINI_FAST),
    label: "Gemini",
  };
}

/** See the note in apps/api/src/main.ts: measured against a real posting, not a toy one. */
const GEMINI_QUALITY = ["gemini-3.5-flash", "gemini-3.6-flash"];
const GEMINI_FAST = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite"];

/** `GEMINI_MODEL_QUALITY=a,b,c` overrides the list; a single name pins one model. */
function modelList(variable: string, fallback: readonly string[]): string[] {
  const configured = (process.env[variable] ?? "").trim();
  if (configured === "") return [...fallback];
  return configured.split(",").map((name) => name.trim()).filter((name) => name !== "");
}

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
    const { transport, quality, fast, label } = chooseProvider();
    llm = new LlmGateway({
      transport,
      cache: options.noCache === true ? new NullCacheStore() : new MemoryCacheStore(clock),
      clock,
      tracer,
      budget,
      models: {
        // Extraction is worth 20 points and asks for `quality`. Everything else takes `fast`.
        //
        // Preferred first, then fallbacks. The floating `-latest` alias leads because Google
        // retires numbered models for newly issued keys — `gemini-2.5-flash` 404s with "no
        // longer available to new users" on a key created today — so a pinned-only list is a
        // time bomb in a repo someone runs months from now. But `gemini-flash-latest` also
        // returned 503 on three consecutive runs while other models answered in under a second,
        // so an alias alone is a different time bomb. The list survives both.
        quality,
        fast,
      },
      requestsPerMinute: Number(process.env["GEMINI_RPM"] ?? 10),
      tokensPerMinute: Number(process.env["GEMINI_TPM"] ?? 250_000),
      // Mirrors apps/api. Batch wants this at least as much as the app does: a stalled free
      // model there costs a case rather than a page load.
      requestBudgetMs: Number(process.env["LLM_REQUEST_TIMEOUT_MS"] ?? DEFAULT_REQUEST_BUDGET_MS),
      ...(options.recordPrompts === true ? { recordPrompts: true } : {}),
    });
    describe.push(`llm: ${label} via gateway${options.noCache === true ? " (cache bypassed)" : ""}`);
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
