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
import {
  DEFAULT_REQUEST_BUDGET_MS,
  GeminiTransport,
  OPENROUTER_FREE_MODELS,
  OpenRouterTransport,
  RoutedTransport,
  ZAI_FAST_MODELS,
  ZAI_QUALITY_MODELS,
  ZaiTransport,
} from "@trao/llm";
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
 * Which providers to talk to, and in what order.
 *
 * Three free or near-free tiers, failing in three different directions. Gemini answers a real
 * extraction prompt in about three seconds and then hits a daily cap that no amount of waiting
 * reopens. Z.AI's GLM models are metered separately and answer the same prompt in about four.
 * OpenRouter's free models take twenty-odd seconds and keep going, which makes them a floor
 * rather than a choice.
 *
 * So the default is all of them, in that order, as one model list. Nothing new was needed to
 * arrange it: the gateway already walks a list and moves to the next name when one reports
 * itself unavailable, a daily cap reports itself exactly that way, and `RoutedTransport` sends
 * each `provider:model` name to the transport that understands it.
 *
 * Batch wants this more than the app does, not less. Five cases is thirty-odd calls, which is
 * several times Gemini's daily cap on its own, so a run pinned to one provider stops partway
 * through and reports failures that are about quota rather than about the pipeline.
 *
 * `LLM_PROVIDER` still pins one — `=gemini`, `=zai`, `=openrouter` — which is what a measurement
 * wants: a number for a provider should not quietly become a number for whichever one answered.
 * It also takes a comma list (`LLM_PROVIDER=zai,gemini`) when the order is worth changing
 * without changing the code.
 */
const PROVIDER_ORDER = ["gemini", "zai", "openrouter"] as const;
type ProviderName = (typeof PROVIDER_ORDER)[number];

interface BuiltProvider {
  transport: ModelTransport;
  quality: string[];
  fast: string[];
}

/** Null when this deployment has no key for it — which is how a provider is dropped. */
function buildProvider(name: ProviderName): BuiltProvider | null {
  switch (name) {
    case "gemini": {
      const apiKey = process.env["GEMINI_API_KEY"] ?? "";
      if (apiKey === "") return null;
      return {
        transport: new GeminiTransport({ apiKey }),
        // Extraction is worth 20 points and asks for `quality`. Everything else takes `fast`.
        quality: modelList("GEMINI_MODEL_QUALITY", GEMINI_QUALITY),
        fast: modelList("GEMINI_MODEL_FAST", GEMINI_FAST),
      };
    }
    case "zai": {
      // `GLM_API_KEY` because that is what the key is called everywhere it is issued, and the
      // provider is called Z.AI everywhere else. Both names work rather than making anyone
      // remember which of the two this repo happened to pick.
      const apiKey = process.env["ZAI_API_KEY"] ?? process.env["GLM_API_KEY"] ?? "";
      if (apiKey === "") return null;
      const baseUrl = process.env["ZAI_BASE_URL"];
      return {
        transport: new ZaiTransport({
          apiKey,
          // The mainland endpoint (open.bigmodel.cn) speaks the same dialect on a different host.
          ...(baseUrl !== undefined && baseUrl !== "" ? { baseUrl } : {}),
        }),
        quality: modelList("ZAI_MODELS", ZAI_QUALITY_MODELS),
        fast: modelList("ZAI_MODELS", ZAI_FAST_MODELS),
      };
    }
    case "openrouter": {
      const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";
      if (apiKey === "") return null;
      const appUrl = process.env["OPENROUTER_APP_URL"];
      const free = modelList("OPENROUTER_MODELS", OPENROUTER_FREE_MODELS);
      return {
        transport: new OpenRouterTransport({
          apiKey,
          appName: "Trao Interview Prep Kit",
          ...(appUrl !== undefined && appUrl !== "" ? { appUrl } : {}),
        }),
        // One list for both tiers: the free models are peers rather than a quality ladder, and
        // claiming otherwise in the wiring would be a fiction the trace would then repeat.
        quality: free,
        fast: free,
      };
    }
  }
}

function chooseProvider(): { transport: ModelTransport; quality: string[]; fast: string[]; label: string } {
  const requested = (process.env["LLM_PROVIDER"] ?? "")
    .split(",")
    .map((name) => canonicalProvider(name))
    .filter((name) => name !== null);

  const wanted: ProviderName[] = requested.length > 0 ? requested : [...PROVIDER_ORDER];
  const built: { name: ProviderName; provider: BuiltProvider }[] = [];

  for (const name of wanted) {
    const provider = buildProvider(name);
    // Asked for by name and unusable: say so. Silently dropping it would turn a typo in an env
    // file into a quiet change of model, which is the kind of thing nobody notices for a day.
    if (provider === null && requested.length > 0) {
      throw new Error(`LLM_PROVIDER names "${name}" but ${keyVariableFor(name)} is not set.`);
    }
    if (provider !== null) built.push({ name, provider });
  }

  if (built.length === 0) {
    throw new Error(
      "No model key. Set GEMINI_API_KEY, ZAI_API_KEY (or GLM_API_KEY) or OPENROUTER_API_KEY in .env, " +
        "or use --fake-llm to run without one.",
    );
  }

  // One provider: plain model names, no routing layer and no prefixes in the trace.
  if (built.length === 1) {
    const [only] = built as [{ name: ProviderName; provider: BuiltProvider }];
    return {
      transport: only.provider.transport,
      quality: only.provider.quality,
      fast: only.provider.fast,
      label: PROVIDER_LABELS[only.name],
    };
  }

  return {
    transport: new RoutedTransport(Object.fromEntries(built.map((b) => [b.name, b.provider.transport]))),
    quality: built.flatMap((b) => b.provider.quality.map((model) => `${b.name}:${model}`)),
    fast: built.flatMap((b) => b.provider.fast.map((model) => `${b.name}:${model}`)),
    label: built.map((b) => PROVIDER_LABELS[b.name]).join(" → "),
  };
}

/** What the run banner calls each one. The banner is read by a human, not parsed. */
const PROVIDER_LABELS: Record<ProviderName, string> = {
  gemini: "Gemini",
  zai: "Z.AI (GLM)",
  openrouter: "OpenRouter (free models)",
};

/** `LLM_PROVIDER` spellings, including the ones people actually type. Unknown names throw. */
function canonicalProvider(raw: string): ProviderName | null {
  const name = raw.trim().toLowerCase();
  if (name === "") return null;
  if (name === "glm" || name === "z.ai" || name === "zhipu") return "zai";
  if (name === "google") return "gemini";
  if ((PROVIDER_ORDER as readonly string[]).includes(name)) return name as ProviderName;
  throw new Error(`LLM_PROVIDER="${raw}" is not a provider. Known: ${PROVIDER_ORDER.join(", ")}.`);
}

function keyVariableFor(name: ProviderName): string {
  if (name === "gemini") return "GEMINI_API_KEY";
  if (name === "zai") return "ZAI_API_KEY or GLM_API_KEY";
  return "OPENROUTER_API_KEY";
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
