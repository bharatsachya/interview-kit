import { describe, expect, it } from "vitest";
import { RoutedTransport, isRouted, split } from "../src/routed";
import { ProviderError, type ModelTransport, type ModelTransportRequest } from "../src/transport";

function recorder(name: string, answer: () => Promise<{ text: string }>): ModelTransport & { seen: string[] } {
  const seen: string[] = [];
  return {
    name,
    seen,
    async send(request: ModelTransportRequest) {
      seen.push(request.model);
      return answer();
    },
  };
}

const answers = () => recorder("ok", async () => ({ text: '{"greeting":"hello"}' }));

describe("routing one model list across two providers", () => {
  it("sends each name to its own provider, with the prefix stripped", async () => {
    const gemini = answers();
    const openrouter = answers();
    const routed = new RoutedTransport({ gemini, openrouter });

    await routed.send({ model: "gemini:gemini-flash-lite-latest", prompt: "p" });
    await routed.send({ model: "openrouter:nex-agi/nex-n2.5-mini:free", prompt: "p" });

    expect(gemini.seen).toEqual(["gemini-flash-lite-latest"]);
    // Split at the FIRST colon only. An OpenRouter name carries its own, and splitting at the
    // last would turn every `:free` model into a provider nobody has heard of.
    expect(openrouter.seen).toEqual(["nex-agi/nex-n2.5-mini:free"]);
  });

  it("reports an unknown provider as unavailable, so the rest of the list still runs", async () => {
    // A list outliving one of its keys is ordinary — it is how a deployment drops a provider.
    // Failing the run over it would make removing a key a breaking change.
    const routed = new RoutedTransport({ gemini: answers() });

    const error = await routed.send({ model: "openrouter:whatever", prompt: "p" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).modelUnavailable).toBe(true);
  });

  it("refuses to be built with no providers at all", () => {
    expect(() => new RoutedTransport({})).toThrow(/at least one/);
  });

  it("splits names without losing colons inside the model", () => {
    expect(split("gemini:gemini-3.5-flash")).toEqual({ provider: "gemini", model: "gemini-3.5-flash" });
    expect(split("openrouter:a/b:free")).toEqual({ provider: "openrouter", model: "a/b:free" });
    expect(split("bare-name")).toEqual({ provider: "", model: "bare-name" });
  });

  it("knows a routed list from a single-provider one", () => {
    expect(isRouted(["gemini:a", "openrouter:b"])).toBe(true);
    expect(isRouted(["gemini:a", "b"])).toBe(false);
    expect(isRouted([])).toBe(false);
  });
});
