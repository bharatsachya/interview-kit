import { describe, expect, it } from "vitest";
import type { Budget, Clock, LlmRequest } from "@trao/contracts";
import { RunBudget, unlimitedBudget } from "../src/budget";
import { FakeTransport, rateLimited, type ScriptedStep } from "../src/fake";
import { LlmGateway, promptHash } from "../src/gateway";
import { MemoryCacheStore } from "../src/memory-cache";
import { ProviderError } from "../src/transport";
import { greetingSchema, RecordingTracer, type Greeting } from "./helpers";

/**
 * A fake clock, local to these tests.
 *
 * `@trao/llm` may only import `contracts`, so `kernel`'s FixedClock is out of reach. Same
 * semantics: sleep advances virtual time and resolves immediately, and sleepers wake in
 * wake-time order — which is what makes "the eleventh call queues" assertable in milliseconds
 * instead of over a real minute.
 */
class TestClock implements Clock {
  #now: number;
  #pending: { wakeAt: number; seq: number; resolve: () => void }[] = [];
  #seq = 0;

  constructor(startAt = 0) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const wakeAt = this.#now + ms;
    return new Promise<void>((resolve) => {
      this.#pending.push({ wakeAt, seq: this.#seq++, resolve });
      queueMicrotask(() => this.advanceTo(wakeAt));
    });
  }

  advanceTo(instant: number): void {
    if (instant <= this.#now) return;
    this.#now = instant;
    const due = this.#pending.filter((p) => p.wakeAt <= instant).sort((a, b) => a.wakeAt - b.wakeAt || a.seq - b.seq);
    this.#pending = this.#pending.filter((p) => p.wakeAt > instant);
    for (const p of due) p.resolve();
  }
}

const OK = JSON.stringify({ greeting: "hello" });

interface Harness {
  gateway: LlmGateway;
  transport: FakeTransport;
  tracer: RecordingTracer;
  clock: TestClock;
  cache: MemoryCacheStore;
  budget: Budget;
}

function harness(
  script: ScriptedStep[] = [OK],
  options: { rpm?: number; tpm?: number; budget?: (clock: Clock) => Budget; maxAttempts?: number } = {},
): Harness {
  const clock = new TestClock(0);
  const transport = new FakeTransport(script);
  const tracer = new RecordingTracer();
  const cache = new MemoryCacheStore(clock);
  const budget = options.budget ? options.budget(clock) : unlimitedBudget(clock);

  const gateway = new LlmGateway({
    transport,
    cache,
    clock,
    tracer,
    budget,
    models: { quality: "model-pro", fast: "model-flash" },
    requestsPerMinute: options.rpm ?? 10,
    tokensPerMinute: options.tpm ?? 250_000,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    // Deterministic jitter: always the top of the range.
    backoff: { random: () => 1 },
  });

  return { gateway, transport, tracer, clock, cache, budget };
}

const ask = (overrides: Partial<LlmRequest<Greeting>> = {}): LlmRequest<Greeting> => ({
  purpose: "greet",
  prompt: "Say hello.",
  schema: greetingSchema,
  ...overrides,
});

describe("the RPM bucket", () => {
  it("queues the eleventh call in a minute rather than firing it", async () => {
    const { gateway, clock } = harness([OK], { rpm: 10 });

    for (let i = 0; i < 10; i += 1) {
      await gateway.complete(ask({ prompt: `Say hello ${i}.` }));
    }
    expect(clock.now(), "the first ten should not have waited").toBe(0);

    await gateway.complete(ask({ prompt: "Say hello 10." }));
    expect(clock.now(), "the eleventh should have waited for the bucket to refill").toBeGreaterThan(0);
  });

  it("reports the wait as queued_ms on the span", async () => {
    const { gateway, tracer } = harness([OK], { rpm: 2 });

    await gateway.complete(ask({ prompt: "one" }));
    await gateway.complete(ask({ prompt: "two" }));
    await gateway.complete(ask({ prompt: "three" }));

    expect(tracer.lastAttrs["queued_ms"]).toBeGreaterThan(0);
  });
});

describe("the TPM bucket", () => {
  it("holds a large prompt back when the token budget is short", async () => {
    // 400 characters ≈ 100 tokens, against a 150-token-per-minute ceiling.
    const { gateway, clock } = harness([OK], { tpm: 150 });

    await gateway.complete(ask({ prompt: "x".repeat(400) }));
    expect(clock.now()).toBe(0);

    await gateway.complete(ask({ prompt: "y".repeat(400) }));
    expect(clock.now(), "the second large prompt should have waited on TPM").toBeGreaterThan(0);
  });

  it("does not hold back small prompts under the same ceiling", async () => {
    const { gateway, clock } = harness([OK], { tpm: 150 });

    await gateway.complete(ask({ prompt: "hi" }));
    await gateway.complete(ask({ prompt: "yo" }));

    expect(clock.now()).toBe(0);
  });
});

describe("retries", () => {
  it("honours Retry-After instead of the backoff default", async () => {
    const { gateway, clock } = harness([rateLimited(5_000), OK]);

    await gateway.complete(ask());

    // Backoff would have been 500ms at attempt 1; the provider said five seconds.
    expect(clock.now()).toBe(5_000);
  });

  it("backs off exponentially when the provider sends no Retry-After", async () => {
    const { gateway, clock } = harness([rateLimited(), rateLimited(), rateLimited(), OK]);

    await gateway.complete(ask());

    // random() is pinned to 1, so each wait is the full ceiling: 500 + 1000 + 2000.
    expect(clock.now()).toBe(3_500);
  });

  it("applies jitter, so concurrent cases do not retry in the same instant", async () => {
    const clock = new TestClock(0);
    const gateway = new LlmGateway({
      transport: new FakeTransport([rateLimited(), OK]),
      cache: new MemoryCacheStore(clock),
      clock,
      tracer: new RecordingTracer(),
      budget: unlimitedBudget(clock),
      models: { quality: "model-pro", fast: "model-flash" },
      backoff: { random: () => 0.25 },
    });

    await gateway.complete(ask());
    expect(clock.now()).toBe(125); // A quarter of the 500ms ceiling, not the whole thing.
  });

  it("gives up after the attempt limit and reports LLM_UNAVAILABLE", async () => {
    const { gateway, transport } = harness([rateLimited()], { maxAttempts: 3 });

    await expect(gateway.complete(ask())).rejects.toMatchObject({ code: "LLM_UNAVAILABLE", retryable: true });
    expect(transport.callCount).toBe(3);
  });

  it("does not retry a request the provider says is malformed", async () => {
    const { gateway, transport } = harness([new ProviderError("400 Bad Request", { status: 400 })]);

    await expect(gateway.complete(ask())).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(transport.callCount, "a 400 will be a 400 again in five seconds").toBe(1);
  });

  it("marks the span rate_limited when it saw a 429", async () => {
    const { gateway, tracer } = harness([rateLimited(1_000), OK]);

    await gateway.complete(ask());
    expect(tracer.lastAttrs["rate_limited"]).toBe(true);
  });
});

describe("the cache", () => {
  it("returns a hit without touching the provider", async () => {
    const { gateway, transport } = harness([OK]);

    const first = await gateway.complete(ask());
    expect(first.cacheHit).toBe(false);
    expect(transport.callCount).toBe(1);

    const second = await gateway.complete(ask());
    expect(second.cacheHit).toBe(true);
    expect(second.data).toEqual({ greeting: "hello" });
    expect(transport.callCount, "a cache hit must cost nothing").toBe(1);
  });

  it("spends no budget on a hit", async () => {
    const clock = new TestClock(0);
    const budget = new RunBudget({ maxCalls: 1, maxTokens: 1_000_000, deadlineAt: 1e12 }, clock);
    const transport = new FakeTransport([OK]);
    const cache = new MemoryCacheStore(clock);
    const gateway = new LlmGateway({
      transport,
      cache,
      clock,
      tracer: new RecordingTracer(),
      budget,
      models: { quality: "model-pro", fast: "model-flash" },
    });

    await gateway.complete(ask());
    // The single permitted call is spent — but the identical second request is free.
    await expect(gateway.complete(ask())).resolves.toMatchObject({ cacheHit: true });
  });

  it("misses when the prompt differs", async () => {
    const { gateway, transport } = harness([OK]);

    await gateway.complete(ask({ prompt: "one" }));
    await gateway.complete(ask({ prompt: "two" }));

    expect(transport.callCount).toBe(2);
  });

  it("misses when the tier — and so the model — differs", async () => {
    const { gateway, transport } = harness([OK]);

    await gateway.complete(ask({ tier: "fast" }));
    await gateway.complete(ask({ tier: "quality" }));

    expect(transport.callCount).toBe(2);
  });

  it("is bypassed by bypassCache, which is what --no-cache wires in", async () => {
    const { gateway, transport } = harness([OK]);

    await gateway.complete(ask());
    await gateway.complete(ask({ bypassCache: true }));

    expect(transport.callCount).toBe(2);
  });

  it("treats an entry that no longer fits the schema as a miss", async () => {
    const { gateway, transport, cache } = harness([OK]);
    await cache.set(`llm:${promptHash("model-flash", "Say hello.")}`, {
      text: JSON.stringify({ salutation: "stale shape" }),
      model: "model-flash",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await gateway.complete(ask());

    expect(result.cacheHit).toBe(false);
    expect(transport.callCount).toBe(1);
  });
});

describe("JSON handling", () => {
  it("accepts a fenced code block without spending a repair", async () => {
    const { gateway, transport, tracer } = harness(["```json\n{ \"greeting\": \"hello\" }\n```"]);

    const result = await gateway.complete(ask());

    expect(result.data).toEqual({ greeting: "hello" });
    expect(transport.callCount, "fixing backticks locally is free").toBe(1);
    expect(tracer.lastAttrs["repair_attempted"]).toBe(false);
  });

  it("accepts JSON wrapped in prose", async () => {
    const { gateway } = harness(['Sure! Here is the JSON:\n{"greeting":"hello"}\nHope that helps.']);
    await expect(gateway.complete(ask())).resolves.toMatchObject({ data: { greeting: "hello" } });
  });

  it("triggers exactly one repair attempt, with the validation error fed back", async () => {
    const { gateway, transport } = harness([JSON.stringify({ salutation: "wrong" }), OK]);

    const result = await gateway.complete(ask());

    expect(result.repaired).toBe(true);
    expect(transport.callCount).toBe(2);
    expect(transport.requests[1]?.prompt).toContain("{ greeting: string }");
    expect(transport.requests[1]?.prompt).toContain("Say hello.");
  });

  it("fails cleanly after the repair, rather than trying a third time", async () => {
    const { gateway, transport } = harness([JSON.stringify({ salutation: "wrong" })]);

    await expect(gateway.complete(ask())).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    expect(transport.callCount).toBe(2);
  });

  it("caches the repaired result under the original prompt, so the next run skips the mistake", async () => {
    const { gateway, transport } = harness([JSON.stringify({ salutation: "wrong" }), OK]);

    await gateway.complete(ask());
    const second = await gateway.complete(ask());

    expect(second.cacheHit).toBe(true);
    expect(transport.callCount).toBe(2);
  });
});

describe("the budget", () => {
  it("surfaces exhaustion as a typed error the pipeline can act on", async () => {
    const { gateway } = harness([OK], {
      budget: (clock) => new RunBudget({ maxCalls: 1, maxTokens: 1_000_000, deadlineAt: 1e12 }, clock),
    });

    await gateway.complete(ask({ prompt: "one" }));
    await expect(gateway.complete(ask({ prompt: "two" }))).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
  });

  it("says which limit ran out", async () => {
    const { gateway } = harness([OK], {
      budget: (clock) => new RunBudget({ maxCalls: 99, maxTokens: 10, deadlineAt: 1e12 }, clock),
    });

    await expect(gateway.complete(ask())).rejects.toThrow(/Token budget/);
  });

  it("stops when the deadline has passed", async () => {
    const { gateway } = harness([OK], {
      budget: (clock) => new RunBudget({ maxCalls: 99, maxTokens: 1e9, deadlineAt: 0 }, clock),
    });

    await expect(gateway.complete(ask())).rejects.toThrow(/Deadline passed/);
  });

  it("does not send the request when the budget is already gone", async () => {
    const { gateway, transport } = harness([OK], {
      budget: (clock) => new RunBudget({ maxCalls: 0, maxTokens: 1e9, deadlineAt: 1e12 }, clock),
    });

    await expect(gateway.complete(ask())).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(transport.callCount).toBe(0);
  });

  it("charges a repair round as the second call it is", async () => {
    const { gateway } = harness([JSON.stringify({ salutation: "wrong" }), OK], {
      budget: (clock) => new RunBudget({ maxCalls: 1, maxTokens: 1e9, deadlineAt: 1e12 }, clock),
    });

    await expect(gateway.complete(ask())).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
  });
});

describe("tiers and tracing", () => {
  it("routes the quality tier to the quality model", async () => {
    const { gateway, transport } = harness([OK]);
    await gateway.complete(ask({ tier: "quality" }));

    expect(transport.requests[0]?.model).toBe("model-pro");
  });

  it("defaults to the fast model", async () => {
    const { gateway, transport } = harness([OK]);
    await gateway.complete(ask());

    expect(transport.requests[0]?.model).toBe("model-flash");
  });

  it("emits every attribute the trace is supposed to carry", async () => {
    const { gateway, tracer } = harness([OK]);
    await gateway.complete(ask());

    expect(tracer.spans[0]?.step).toBe("llm:greet");
    for (const key of [
      "model",
      "prompt_hash",
      "cache_hit",
      "input_tokens",
      "output_tokens",
      "attempt",
      "queued_ms",
      "rate_limited",
      "repair_attempted",
    ]) {
      expect(tracer.lastAttrs, `missing trace attribute ${key}`).toHaveProperty(key);
    }
  });

  it("records the span as failed when the call fails", async () => {
    const { gateway, tracer } = harness([new ProviderError("500", { status: 500 })], { maxAttempts: 1 });

    await expect(gateway.complete(ask())).rejects.toThrow();
    expect(tracer.spans[0]?.status).toBe("failed");
  });
});

describe("--record-prompts", () => {
  it("records nothing by default, so a production trace is not a copy of the user's input", async () => {
    const { gateway, tracer } = harness([OK]);
    await gateway.complete(ask());

    expect(tracer.lastAttrs["prompt"]).toBeUndefined();
    expect(tracer.lastAttrs["response"]).toBeUndefined();
    // The hash is always there, so calls can still be correlated without storing the text.
    expect(tracer.lastAttrs["prompt_hash"]).toBeDefined();
  });

  it("records the prompt and the raw response when asked", async () => {
    const clock = new TestClock(0);
    const tracer = new RecordingTracer();
    const gateway = new LlmGateway({
      transport: new FakeTransport([OK]),
      cache: new MemoryCacheStore(clock),
      clock,
      tracer,
      budget: unlimitedBudget(clock),
      models: { quality: "model-pro", fast: "model-flash" },
      recordPrompts: true,
    });

    await gateway.complete(ask({ prompt: "Say hello politely." }));

    expect(tracer.lastAttrs["prompt"]).toBe("Say hello politely.");
    expect(tracer.lastAttrs["response"]).toBe(OK);
  });

  it("records both rounds separately when a repair happens", async () => {
    const clock = new TestClock(0);
    const tracer = new RecordingTracer();
    const gateway = new LlmGateway({
      transport: new FakeTransport([JSON.stringify({ salutation: "wrong" }), OK]),
      cache: new MemoryCacheStore(clock),
      clock,
      tracer,
      budget: unlimitedBudget(clock),
      models: { quality: "model-pro", fast: "model-flash" },
      recordPrompts: true,
    });

    await gateway.complete(ask());

    expect(tracer.lastAttrs["response"]).toContain("salutation");
    expect(tracer.lastAttrs["repair_prompt"]).toContain("{ greeting: string }");
    expect(tracer.lastAttrs["repair_response"]).toBe(OK);
  });

  it("clips a very long prompt, so one trace cannot be fifty megabytes", async () => {
    const clock = new TestClock(0);
    const tracer = new RecordingTracer();
    const gateway = new LlmGateway({
      transport: new FakeTransport([OK]),
      cache: new MemoryCacheStore(clock),
      clock,
      tracer,
      budget: unlimitedBudget(clock),
      models: { quality: "model-pro", fast: "model-flash" },
      recordPrompts: true,
      recordedPromptChars: 100,
    });

    await gateway.complete(ask({ prompt: "x".repeat(5_000) }));

    expect(String(tracer.lastAttrs["prompt"]).length).toBeLessThan(200);
    expect(String(tracer.lastAttrs["prompt"])).toContain("more characters]");
  });
});
