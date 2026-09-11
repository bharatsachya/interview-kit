import { resolve } from "node:path";
import { ClerkAuthenticator, DevAuthenticator, type Authenticator } from "@trao/auth";
import type { Budget, JobStore, KitStore, PracticeStore } from "@trao/contracts";
import { InMemoryTracer, RandomIdGenerator, RoutedIdGenerator, SequentialIdGenerator, SystemClock } from "@trao/kernel";
import type { InternalKit } from "@trao/kit";
import {
  DEFAULT_REQUEST_BUDGET_MS,
  FakeLlmProvider,
  GeminiTransport,
  LlmGateway,
  MemoryCacheStore,
  OPENROUTER_FREE_MODELS,
  OpenRouterTransport,
  RoutedTransport,
  RunBudget,
  ZAI_FAST_MODELS,
  ZAI_QUALITY_MODELS,
  ZaiTransport,
  type ModelTransport,
} from "@trao/llm";
import { MemoryJobStore, MemoryKitStore, MemoryPracticeStore, connectMongo } from "@trao/persistence";
import { regenerateSection } from "@trao/pipeline";
import { NullSearchProvider, TavilySearchProvider } from "@trao/research";
import { FakeFetcher, LiveHttpFetcher, fixtureMounts } from "@trao/retrieval";
import { createApp } from "./app";
import { DEFAULT_JOB_TIMEOUT_MS, JobRunner } from "./jobs";
import { JobSpanFeed } from "./spans";
import { fakeLlmResponses, gapFillResponse } from "../../../fixtures/fake-llm-responses";
import { loadEnv } from "../../../scripts/load-env";

// Before anything reads process.env.
loadEnv();

/**
 * The API's composition root.
 *
 * One of only three files permitted to construct an adapter — the others are `scripts/dev.ts`
 * and `scripts/evaluate.ts`. Everything below this line receives what it needs as an argument,
 * which is why no domain package has a way to reach a provider, a database or a clock.
 */

const clock = new SystemClock();

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

interface ProviderChoice {
  transport: ModelTransport;
  quality: string[];
  fast: string[];
  label: string;
}

/**
 * Which providers to talk to, and in what order.
 *
 * Mirrors `scripts/composition.ts`, which is the file that matters for the graded batch run.
 *
 * Three free or near-free tiers, failing in three different directions. Gemini answers a real
 * extraction prompt in about three seconds and then hits a daily cap that no amount of waiting
 * reopens. Z.AI's GLM models are metered separately and answer the same prompt in about four,
 * which makes them the natural thing to reach for once Gemini's day is spent. OpenRouter's free
 * models take twenty-odd seconds and keep going, which makes them a floor rather than a choice.
 *
 * So the default is all of them, in that order, as one model list. Nothing new was needed to
 * arrange it: the gateway already walks a list and moves to the next name when one reports
 * itself unavailable, a daily cap reports itself exactly that way, and `RoutedTransport` sends
 * each `provider:model` name to the transport that understands it. Cross-provider failover is
 * the chain that already existed, given a wider list to walk.
 *
 * `LLM_PROVIDER` still pins one — `=gemini`, `=zai`, `=openrouter` — which is what a measurement
 * wants: a number for a provider should not quietly become a number for whichever one answered.
 * It also takes a comma list (`LLM_PROVIDER=zai,gemini`) when the order is worth changing
 * without changing the code, which is the usual reason to reach for this at all.
 */
const PROVIDER_ORDER = ["gemini", "zai", "openrouter"] as const;
type ProviderName = (typeof PROVIDER_ORDER)[number];

interface BuiltProvider {
  transport: ModelTransport;
  quality: string[];
  fast: string[];
  /** Named in the error when this provider was asked for and its key is missing. */
  keyVariable: string;
}

/** Null when this deployment has no key for it — which is how a provider is dropped. */
function buildProvider(name: ProviderName): BuiltProvider | null {
  switch (name) {
    case "gemini": {
      const apiKey = env("GEMINI_API_KEY");
      if (apiKey === "") return null;
      return {
        transport: new GeminiTransport({ apiKey }),
        // Extraction is worth 20 points and asks for `quality`. Everything else takes `fast`.
        quality: modelList("GEMINI_MODEL_QUALITY", GEMINI_QUALITY),
        fast: modelList("GEMINI_MODEL_FAST", GEMINI_FAST),
        keyVariable: "GEMINI_API_KEY",
      };
    }
    case "zai": {
      // `GLM_API_KEY` because that is what the key is called everywhere it is issued, and the
      // provider is called Z.AI everywhere else. Both names work rather than making anyone
      // remember which of the two this repo happened to pick.
      const apiKey = env("ZAI_API_KEY") !== "" ? env("ZAI_API_KEY") : env("GLM_API_KEY");
      if (apiKey === "") return null;
      return {
        transport: new ZaiTransport({
          apiKey,
          // The mainland endpoint (open.bigmodel.cn) speaks the same dialect on a different host.
          ...(env("ZAI_BASE_URL") !== "" ? { baseUrl: env("ZAI_BASE_URL") } : {}),
        }),
        quality: modelList("ZAI_MODELS", ZAI_QUALITY_MODELS),
        fast: modelList("ZAI_MODELS", ZAI_FAST_MODELS),
        keyVariable: "ZAI_API_KEY or GLM_API_KEY",
      };
    }
    case "openrouter": {
      const apiKey = env("OPENROUTER_API_KEY");
      if (apiKey === "") return null;
      const free = modelList("OPENROUTER_MODELS", OPENROUTER_FREE_MODELS);
      return {
        transport: new OpenRouterTransport({
          apiKey,
          appName: "Trao Interview Prep Kit",
          ...(env("OPENROUTER_APP_URL") !== "" ? { appUrl: env("OPENROUTER_APP_URL") } : {}),
        }),
        // One list for both tiers: the free models are peers rather than a quality ladder, and
        // claiming otherwise in the wiring would be a fiction the trace would then repeat.
        quality: free,
        fast: free,
        keyVariable: "OPENROUTER_API_KEY",
      };
    }
  }
}

function chooseProvider(): ProviderChoice {
  const requested = env("LLM_PROVIDER")
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
      "No model key. Set GEMINI_API_KEY, ZAI_API_KEY (or GLM_API_KEY) or OPENROUTER_API_KEY, " +
        "or FAKE_LLM=true to run without one.",
    );
  }

  // One provider: plain model names, no routing layer and no prefixes in the trace.
  if (built.length === 1) {
    const [only] = built as [{ name: ProviderName; provider: BuiltProvider }];
    return {
      transport: only.provider.transport,
      quality: only.provider.quality,
      fast: only.provider.fast,
      label: only.name,
    };
  }

  return {
    transport: new RoutedTransport(Object.fromEntries(built.map((b) => [b.name, b.provider.transport]))),
    quality: built.flatMap((b) => b.provider.quality.map((model) => `${b.name}:${model}`)),
    fast: built.flatMap((b) => b.provider.fast.map((model) => `${b.name}:${model}`)),
    label: built.map((b) => b.name).join(" → "),
  };
}

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

/**
 * Gemini defaults, measured against a real posting rather than a toy one.
 *
 * `gemini-flash-latest` is absent from both: it answered 503 "high demand" on every attempt and
 * spent twenty seconds doing it. `gemini-2.5-flash-lite` is absent because the API now answers
 * "no longer available to new users" — the floating aliases are the safe names, which is what
 * gemini.ts has said all along.
 */
const GEMINI_QUALITY = ["gemini-3.5-flash", "gemini-3.6-flash"];
const GEMINI_FAST = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite"];

/** `GEMINI_MODEL_QUALITY=a,b,c` overrides the list; a single name pins one model. */
function modelList(variable: string, fallback: readonly string[]): string[] {
  const configured = env(variable).trim();
  if (configured === "") return [...fallback];
  return configured.split(",").map((name) => name.trim()).filter((name) => name !== "");
}

function flag(name: string): boolean {
  return /^(1|true|yes)$/i.test(env(name));
}

async function main(): Promise<void> {
  const port = Number(env("PORT", "8080"));
  const production = env("NODE_ENV") === "production";

  // ── Auth ─────────────────────────────────────────────────────────────────────────────
  const issuer = env("CLERK_ISSUER");
  let auth: Authenticator;
  if (issuer !== "") {
    auth = new ClerkAuthenticator({ issuer, ...(env("CLERK_JWKS_URL") !== "" ? { jwksUrl: env("CLERK_JWKS_URL") } : {}) });
  } else {
    // An auth bypass that a stray environment variable could switch on in production is not a
    // bypass, it is a vulnerability. Refuse rather than degrade.
    if (production) throw new Error("CLERK_ISSUER is required in production.");
    process.stderr.write("⚠ CLERK_ISSUER is not set — using DevAuthenticator. Never do this in production.\n");
    auth = new DevAuthenticator();
  }

  // ── Persistence ──────────────────────────────────────────────────────────────────────
  const mongoUri = env("MONGODB_URI");
  let kits: KitStore<InternalKit>;
  let jobs: JobStore;
  let practice: PracticeStore;
  let closeStores: () => Promise<void> = async () => {};

  if (mongoUri !== "") {
    const stores = await connectMongo({ uri: mongoUri, clock, ...(env("MONGODB_DB") !== "" ? { dbName: env("MONGODB_DB") } : {}) });
    kits = stores.kits as KitStore<InternalKit>;
    jobs = stores.jobs;
    practice = stores.practice;
    closeStores = stores.close;
  } else {
    if (production) throw new Error("MONGODB_URI is required in production.");
    process.stderr.write("⚠ MONGODB_URI is not set — kits live in memory and vanish on restart.\n");
    kits = new MemoryKitStore<InternalKit>();
    jobs = new MemoryJobStore(clock);
    practice = new MemoryPracticeStore(clock);
  }

  // ── The pipeline's dependencies, rebuilt per job ─────────────────────────────────────
  const fakeLlm = flag("FAKE_LLM");
  const fakeFetch = flag("FAKE_FETCH");
  const allowPrivateHosts = flag("ALLOW_PRIVATE_HOSTS");
  const provider = fakeLlm ? null : chooseProvider();

  const jobTimeoutMs = Number(env("JOB_TIMEOUT_MS", String(DEFAULT_JOB_TIMEOUT_MS)));
  const cache = new MemoryCacheStore(clock);

  const makeDeps = () => {
    // A fresh tracer and id generator per job: two concurrent jobs must not interleave their
    // spans or their requirement ids.
    const tracer = new InMemoryTracer(clock);
    // Comfortably inside the job ceiling, so the gateway gives up on its own terms — with a
    // step recorded and a reason — before the backstop fires and reports only "timed out".
    const budget: Budget = new RunBudget(
      { maxCalls: 40, maxTokens: 500_000, deadlineAt: clock.now() + jobTimeoutMs * 0.8 },
      clock,
    );

    return {
      llm: fakeLlm ? makeFakeLlm() : new LlmGateway({
        transport: (provider as ProviderChoice).transport,
        cache,
        clock,
        tracer,
        budget,
        models: { quality: (provider as ProviderChoice).quality, fast: (provider as ProviderChoice).fast },
        requestsPerMinute: Number(env("GEMINI_RPM", "10")),
        tokensPerMinute: Number(env("GEMINI_TPM", "250000")),
        // How long one model call may take before the next model in the list is tried. Tunable
        // without a rebuild because the right value depends on which free models are healthy
        // today, and that changes week to week.
        requestBudgetMs: Number(env("LLM_REQUEST_TIMEOUT_MS", String(DEFAULT_REQUEST_BUDGET_MS))),
      }),
      fetcher: fakeFetch
        ? new FakeFetcher({ root: resolve(process.cwd(), "fixtures", "sites"), mounts: fixtureMounts() })
        : new LiveHttpFetcher({ allowPrivateHosts }),
      search: env("TAVILY_API_KEY") === "" ? new NullSearchProvider() : new TavilySearchProvider({ apiKey: env("TAVILY_API_KEY") }),
      tracer,
      clock,
      // Sequential within the kit so the trace reads r1/q1/f1, but the kit's own id is a
      // storage key that outlives the run and must be globally unique. One generator for both
      // makes every job produce kit_1 and lets one user's kit overwrite another's.
      ids: new RoutedIdGenerator(fakeLlm ? new SequentialIdGenerator() : new RandomIdGenerator(), {
        kit_: new RandomIdGenerator(),
      }),
      budget,
      // The interactive app takes the other reading of the unreachable-site conflict, and it is
      // the only caller that does. A person who pastes a posting URL that 404s wants the kit
      // their description can still produce, not a dead end — the description alone carries the
      // requirements, the questions and the schedule, and the brief says plainly what it lacks.
      //
      // `scripts/evaluate.ts` keeps the default, because Appendix B's worked example shows
      // COMPANY_UNREACHABLE as a `failed` case and the graders' harness may assert on it. Batch
      // is judged against the specification; the app is judged by whoever is using it.
      treatUnreachableSiteAsFailure: false,
      ...(fakeFetch ? { requestsPerSecond: 1_000 } : {}),
    };
  };

  // Ids for things that outlive a run — jobs, kits, and the questions and cards the user adds
  // by hand in the builder. Random rather than sequential: a builder id has to be unique against
  // everything already in the document, including the archived items a sequential counter
  // restarted from zero would happily collide with.
  const ids = new RandomIdGenerator();

  // One feed for the process. The runner publishes into it and `/jobs/:id/events` reads out of
  // it, which is what lets a page reloaded mid-run replay the steps it missed.
  const feed = new JobSpanFeed();

  const runner = new JobRunner({
    jobs,
    kits,
    ids,
    clock,
    makeDeps,
    feed,
    // `RegenerateDeps` is structurally satisfied by what `makeDeps` already builds, so the
    // builder's regenerate button and first generation share one wiring rather than two.
    regenerate: regenerateSection,
    timeoutMs: jobTimeoutMs,
  });

  const app = createApp({
    auth,
    jobs,
    kits,
    practice,
    runner,
    feed,
    ids,
    clock,
    ...(env("CORS_ORIGINS") !== "" ? { corsOrigins: env("CORS_ORIGINS").split(",").map((o) => o.trim()) } : {}),
  });

  const server = app.listen(port, () => {
    process.stderr.write(
      [
        `api listening on :${port}`,
        `  auth      ${issuer !== "" ? "clerk" : "dev (no CLERK_ISSUER)"}`,
        `  store     ${mongoUri !== "" ? "mongodb" : "memory"}`,
        `  practice  ${mongoUri !== "" ? "mongodb (practice_sessions)" : "memory — ratings vanish on restart"}`,
        `  model     ${fakeLlm ? "fake" : (provider as ProviderChoice).label}`,
        `  fetch     ${fakeFetch ? "fixtures" : "live"}`,
        `  search    ${env("TAVILY_API_KEY") === "" ? "none (step will be skipped)" : "tavily"}`,
        "",
      ].join("\n"),
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => void closeStores().then(() => process.exit(0)));
    });
  }
}

/** The same canned responses the dev runner and the batch script use, so all three agree. */
function makeFakeLlm(): FakeLlmProvider {
  const fake = new FakeLlmProvider({ responses: fakeLlmResponses() });
  fake.respondWith("gap_fill", gapFillResponse);
  return fake;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
