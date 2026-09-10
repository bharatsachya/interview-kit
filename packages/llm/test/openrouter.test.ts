import { describe, expect, it } from "vitest";
import { OPENROUTER_FREE_MODELS, OpenRouterTransport } from "../src/openrouter";
import { ProviderError } from "../src/transport";

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const reply = (content: string) => ({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 34 },
});

function transport(fetchImpl: typeof fetch) {
  return new OpenRouterTransport({ apiKey: "sk-test", fetchImpl, appName: "Trao Interview Prep Kit" });
}

describe("OpenRouterTransport", () => {
  it("returns the text and the reported usage", async () => {
    const result = await transport(async () => ok(reply('{"greeting":"hello"}'))).send({
      model: "deepseek/deepseek-chat-v3-0324:free",
      prompt: "Say hello.",
    });

    expect(result.text).toBe('{"greeting":"hello"}');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
  });

  it("sends the key as a bearer token, never in the URL", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      seen = { url: String(input), init: init ?? {} };
      return ok(reply("{}"));
    };

    await transport(fetchImpl).send({ model: "m", prompt: "p" });

    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).not.toContain("sk-test");
    expect((call.init.headers as Record<string, string>)["authorization"]).toBe("Bearer sk-test");
  });

  it("asks for JSON at the protocol level", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ok(reply("{}"));
    };

    await transport(fetchImpl).send({ model: "m", prompt: "p", maxOutputTokens: 500 });

    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(body["max_tokens"]).toBe(500);
    expect(body["messages"]).toEqual([{ role: "user", content: "p" }]);
  });

  it("flags a retired free model so the gateway moves to the next one", async () => {
    const failing = transport(async () => ok({ error: { message: "No endpoints found" } }, 404));

    await expect(failing.send({ model: "gone:free", prompt: "p" })).rejects.toMatchObject({ status: 404 });
    await expect(failing.send({ model: "gone:free", prompt: "p" })).rejects.toThrow(/Free models rotate/);
  });

  it("honours Retry-After on a rate limit", async () => {
    const limited = transport(async () => ok({ error: { message: "rate limited" } }, 429, { "retry-after": "7" }));

    const error = await limited.send({ model: "m", prompt: "p" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryAfterMs).toBe(7000);
  });

  it("treats a 200 carrying an error body as a failure", async () => {
    // OpenRouter answers 200 when an upstream provider fails mid-request.
    const odd = transport(async () => ok({ error: { message: "upstream exploded", code: 502 } }));

    await expect(odd.send({ model: "m", prompt: "p" })).rejects.toThrow(/upstream exploded/);
  });

  it("rejects an empty completion rather than passing it on", async () => {
    const empty = transport(async () => ok({ choices: [{ message: { content: "" }, finish_reason: "length" }] }));

    await expect(empty.send({ model: "m", prompt: "p" })).rejects.toThrow(/no text \(finish_reason: length\)/);
  });

  it("marks a network failure retryable", async () => {
    const dead = transport(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(dead.send({ model: "m", prompt: "p" })).rejects.toMatchObject({ retryable: true });
  });

  it("ships free models that all carry the :free suffix", () => {
    expect(OPENROUTER_FREE_MODELS.length).toBeGreaterThan(1);
    for (const model of OPENROUTER_FREE_MODELS) expect(model.endsWith(":free")).toBe(true);
  });
});
