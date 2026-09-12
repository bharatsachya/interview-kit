import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/transport";
import { ZAI_FAST_MODELS, ZAI_QUALITY_MODELS, ZaiTransport } from "../src/zai";

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const reply = (content: string) => ({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 34 },
});

/** The provider's own words for the one 400 that must not be treated as a bad request. */
const thinkingRejection = {
  error: { code: "1210", message: "This model always engages in thinking and cannot be disabled; please use low, high, or max" },
};

function transport(fetchImpl: typeof fetch) {
  return new ZaiTransport({ apiKey: "zk-test", fetchImpl });
}

/** Records every request body the transport sent, in order. */
function recording(respond: (body: Record<string, unknown>, call: number) => Response) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return respond(body, bodies.length);
  };
  return { bodies, fetchImpl };
}

describe("ZaiTransport", () => {
  it("returns the text and the reported usage", async () => {
    const result = await transport(async () => ok(reply('{"greeting":"hello"}'))).send({
      model: "glm-5.3-flash",
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

    await transport(fetchImpl).send({ model: "glm-5.3", prompt: "p" });

    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(call.url).not.toContain("zk-test");
    expect((call.init.headers as Record<string, string>)["authorization"]).toBe("Bearer zk-test");
  });

  it("asks for JSON and for the reasoning budget to be turned down", async () => {
    // Left alone every GLM model here thinks before answering, which is the difference between
    // nine seconds and forty-four against a thirty-second per-request budget.
    const { bodies, fetchImpl } = recording(() => ok(reply("{}")));

    await transport(fetchImpl).send({ model: "glm-4.6", prompt: "p", maxOutputTokens: 500 });

    expect(bodies[0]?.["response_format"]).toEqual({ type: "json_object" });
    expect(bodies[0]?.["thinking"]).toEqual({ type: "disabled" });
    expect(bodies[0]?.["reasoning_effort"]).toBe("low");
    expect(bodies[0]?.["max_tokens"]).toBe(500);
    expect(bodies[0]?.["messages"]).toEqual([{ role: "user", content: "p" }]);
  });

  it("drops `thinking` for a model that rejects it, and remembers", async () => {
    // The two GLM families disagree about how to say "think less" and neither accepts the
    // other's word. Discovering it costs one 400 per model per process; hardcoding a list of
    // model names would cost a silent forty-second call the first time the list rots.
    const { bodies, fetchImpl } = recording((_body, call) =>
      call === 1 ? ok(thinkingRejection, 400) : ok(reply('{"ok":true}')),
    );
    const zai = transport(fetchImpl);

    const first = await zai.send({ model: "glm-5.3-flash", prompt: "p" });
    expect(first.text).toBe('{"ok":true}');
    expect(bodies[0]?.["thinking"]).toEqual({ type: "disabled" });
    expect(bodies[1]).not.toHaveProperty("thinking");
    // `reasoning_effort` is the knob this family does honour, so it stays.
    expect(bodies[1]?.["reasoning_effort"]).toBe("low");

    await zai.send({ model: "glm-5.3-flash", prompt: "p2" });
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("thinking");
  });

  it("keeps `thinking` for models that never rejected it", async () => {
    const { bodies, fetchImpl } = recording((body, call) =>
      call === 1 && body["model"] === "glm-5.3" ? ok(thinkingRejection, 400) : ok(reply("{}")),
    );
    const zai = transport(fetchImpl);

    await zai.send({ model: "glm-5.3", prompt: "p" });
    await zai.send({ model: "glm-4.6", prompt: "p" });

    expect(bodies[2]?.["model"]).toBe("glm-4.6");
    expect(bodies[2]?.["thinking"]).toEqual({ type: "disabled" });
  });

  it("reads an unknown model as unavailable rather than as a bad request", async () => {
    // 400 + code 1211. By status alone this is indistinguishable from a malformed request, and
    // getting it wrong means a rotated model name fails the run instead of falling through.
    const failing = transport(async () =>
      ok({ error: { code: "1211", message: "Unknown Model, please check the model code." } }, 400),
    );

    const error = (await failing.send({ model: "glm-gone", prompt: "p" }).catch((e: unknown) => e)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.modelUnavailable).toBe(true);
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/ZAI_MODELS/);
  });

  it("reads an exhausted quota as unavailable, so the chain reaches the next provider", async () => {
    const spent = transport(async () => ok({ error: { code: "1113", message: "Insufficient balance" } }, 400));

    const error = (await spent.send({ model: "glm-5.3", prompt: "p" }).catch((e: unknown) => e)) as ProviderError;

    expect(error.modelUnavailable).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("waits out a rate limit rather than moving on", async () => {
    // The account's own limit, not the model's: every other GLM name would say the same thing.
    const limited = transport(async () => ok({ error: { code: "1302", message: "Too many concurrent" } }, 429, { "retry-after": "3" }));

    const error = (await limited.send({ model: "glm-5.3", prompt: "p" }).catch((e: unknown) => e)) as ProviderError;

    expect(error.retryable).toBe(true);
    expect(error.modelUnavailable).toBe(false);
    expect(error.retryAfterMs).toBe(3000);
  });

  it("moves on from a model that spent its whole budget thinking", async () => {
    // Empty `content` with a full `reasoning_content`. Retrying the same prompt produces the
    // same thing; the next model in the list has not made that mistake yet.
    const thinker = transport(async () =>
      ok({ choices: [{ message: { content: "", reasoning_content: "Okay, the user wants" }, finish_reason: "length" }] }),
    );

    const error = (await thinker.send({ model: "glm-4.5-flash", prompt: "p" }).catch((e: unknown) => e)) as ProviderError;

    expect(error.modelUnavailable).toBe(true);
    expect(error.message).toMatch(/reasoning/);
  });

  it("treats a timeout as this model's problem, and a socket error as a blip", async () => {
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const timedOut = (await transport(async () => {
      throw timeout;
    })
      .send({ model: "glm-5.3", prompt: "p" })
      .catch((e: unknown) => e)) as ProviderError;

    expect(timedOut.modelUnavailable).toBe(true);
    expect(timedOut.retryable).toBe(false);

    const dropped = (await transport(async () => {
      throw new Error("socket hang up");
    })
      .send({ model: "glm-5.3", prompt: "p" })
      .catch((e: unknown) => e)) as ProviderError;

    expect(dropped.retryable).toBe(true);
    expect(dropped.modelUnavailable).toBe(false);
  });

  it("asks again without the JSON hint when a model cannot do structured output", async () => {
    const { bodies, fetchImpl } = recording((_body, call) =>
      call === 1 ? ok({ error: { code: "1210", message: "does not support feature: structured-outputs" } }, 400) : ok(reply("{}")),
    );

    await transport(fetchImpl).send({ model: "glm-4.6", prompt: "p" });

    expect(bodies[0]).toHaveProperty("response_format");
    expect(bodies[1]).not.toHaveProperty("response_format");
  });

  it("honours a configured base URL, for the mainland endpoint", async () => {
    let url = "";
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return ok(reply("{}"));
    };

    await new ZaiTransport({ apiKey: "k", fetchImpl, baseUrl: "https://open.bigmodel.cn/api/paas/v4/" }).send({
      model: "glm-4.6",
      prompt: "p",
    });

    expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
  });

  it("ranks the fast list by the flash variant and the quality list by the larger one", () => {
    // Both were measured against a real extraction prompt, half a second apart; the lists say
    // which one leads rather than leaving it to whichever order the file happened to have.
    expect(ZAI_FAST_MODELS[0]).toBe("glm-5.3-flash");
    expect(ZAI_QUALITY_MODELS[0]).toBe("glm-5.3");
    // Both keep the older family last, which is what exercises the negotiation in production.
    expect(ZAI_FAST_MODELS.at(-1)).toBe("glm-4.6");
    expect(ZAI_QUALITY_MODELS.at(-1)).toBe("glm-4.6");
  });
});
