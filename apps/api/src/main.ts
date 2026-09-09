import { resolve } from "node:path";
import { ClerkAuthenticator, DevAuthenticator, type Authenticator } from "@trao/auth";
import type { Budget, JobStore, KitStore } from "@trao/contracts";
import { InMemoryTracer, RandomIdGenerator, RoutedIdGenerator, SequentialIdGenerator, SystemClock } from "@trao/kernel";
import type { InternalKit } from "@trao/kit";
import { FakeLlmProvider, GeminiTransport, LlmGateway, MemoryCacheStore, RunBudget } from "@trao/llm";
import { MemoryJobStore, MemoryKitStore, connectMongo } from "@trao/persistence";
import { NullSearchProvider, TavilySearchProvider } from "@trao/research";
import { FakeFetcher, LiveHttpFetcher, fixtureMounts } from "@trao/retrieval";
import { createApp } from "./app";
import { JobRunner } from "./jobs";
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
  let closeStores: () => Promise<void> = async () => {};

  if (mongoUri !== "") {
    const stores = await connectMongo({ uri: mongoUri, clock, ...(env("MONGODB_DB") !== "" ? { dbName: env("MONGODB_DB") } : {}) });
    kits = stores.kits as KitStore<InternalKit>;
    jobs = stores.jobs;
    closeStores = stores.close;
  } else {
    if (production) throw new Error("MONGODB_URI is required in production.");
    process.stderr.write("⚠ MONGODB_URI is not set — kits live in memory and vanish on restart.\n");
    kits = new MemoryKitStore<InternalKit>();
    jobs = new MemoryJobStore(clock);
  }

  // ── The pipeline's dependencies, rebuilt per job ─────────────────────────────────────
  const fakeLlm = flag("FAKE_LLM");
  const fakeFetch = flag("FAKE_FETCH");
  const allowPrivateHosts = flag("ALLOW_PRIVATE_HOSTS");
  const geminiKey = env("GEMINI_API_KEY");

  if (!fakeLlm && geminiKey === "") {
    throw new Error("GEMINI_API_KEY is not set. Set FAKE_LLM=true to run the API without a model.");
  }

  const cache = new MemoryCacheStore(clock);

  const makeDeps = () => {
    // A fresh tracer and id generator per job: two concurrent jobs must not interleave their
    // spans or their requirement ids.
    const tracer = new InMemoryTracer(clock);
    const budget: Budget = new RunBudget(
      { maxCalls: 40, maxTokens: 500_000, deadlineAt: clock.now() + 5 * 60_000 },
      clock,
    );

    return {
      llm: fakeLlm ? makeFakeLlm() : new LlmGateway({
        transport: new GeminiTransport({ apiKey: geminiKey }),
        cache,
        clock,
        tracer,
        budget,
        models: {
          quality: env("GEMINI_MODEL_QUALITY", "gemini-2.5-flash"),
          fast: env("GEMINI_MODEL_FAST", "gemini-2.5-flash-lite"),
        },
        requestsPerMinute: Number(env("GEMINI_RPM", "10")),
        tokensPerMinute: Number(env("GEMINI_TPM", "250000")),
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
      ...(fakeFetch ? { requestsPerSecond: 1_000 } : {}),
    };
  };

  const runner = new JobRunner({ jobs, kits, ids: new RandomIdGenerator(), clock, makeDeps });

  const app = createApp({
    auth,
    jobs,
    kits,
    runner,
    ...(env("CORS_ORIGINS") !== "" ? { corsOrigins: env("CORS_ORIGINS").split(",").map((o) => o.trim()) } : {}),
  });

  const server = app.listen(port, () => {
    process.stderr.write(
      [
        `api listening on :${port}`,
        `  auth      ${issuer !== "" ? "clerk" : "dev (no CLERK_ISSUER)"}`,
        `  store     ${mongoUri !== "" ? "mongodb" : "memory"}`,
        `  model     ${fakeLlm ? "fake" : "gemini"}`,
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
