import { ProviderError, type ModelTransport, type ModelTransportRequest, type ModelTransportResponse } from "./transport";

/**
 * One model list spanning two providers.
 *
 * The two free tiers fail in opposite directions. Gemini answers a real extraction prompt in
 * about three seconds and then runs out: the cap is a daily one, per model, and no amount of
 * waiting reopens it within a session. OpenRouter's free models take twenty-odd seconds and
 * keep going. Either alone is a bad deployment — fast until it is dead, or alive but slow.
 *
 * Nothing new is needed to combine them. The gateway already walks a list of models and moves
 * to the next when one reports itself unavailable, and a daily cap reports itself exactly that
 * way. So the list simply names models from both providers, and this routes each name to the
 * transport that understands it. Cross-provider failover is the chain that already existed,
 * given a wider list to walk.
 *
 * Names are `provider:model`, split at the first colon only — an OpenRouter name carries its own
 * (`openrouter:nex-agi/nex-n2.5-mini:free`), and splitting at the last one would quietly mangle
 * every free model there is.
 */
export class RoutedTransport implements ModelTransport {
  readonly name: string;

  constructor(private readonly routes: Record<string, ModelTransport>) {
    const names = Object.keys(routes);
    if (names.length === 0) throw new Error("RoutedTransport needs at least one provider.");
    this.name = names.join("+");
  }

  async send(request: ModelTransportRequest): Promise<ModelTransportResponse> {
    const { provider, model } = split(request.model);
    const transport = this.routes[provider];

    if (transport === undefined) {
      // Unavailable rather than invalid, so a name for a provider this deployment has no key
      // for is skipped and the rest of the list still runs. A list outliving one of its keys is
      // the ordinary case — it is how a deployment drops a provider.
      throw new ProviderError(
        `No transport for "${provider}". Model names must be provider-prefixed, e.g. ` +
          `gemini:gemini-flash-lite-latest. Configured: ${Object.keys(this.routes).join(", ")}.`,
        { retryable: false, modelUnavailable: true },
      );
    }

    return transport.send({ ...request, model });
  }
}

/** `gemini:flash` → `{ provider: "gemini", model: "flash" }`. Unprefixed names have no provider. */
export function split(name: string): { provider: string; model: string } {
  const at = name.indexOf(":");
  if (at === -1) return { provider: "", model: name };
  return { provider: name.slice(0, at), model: name.slice(at + 1) };
}

/** Whether every name in a list carries a provider prefix — how a caller knows to route at all. */
export function isRouted(models: readonly string[]): boolean {
  return models.length > 0 && models.every((name) => split(name).provider !== "");
}
