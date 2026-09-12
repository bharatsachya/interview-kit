import { describe, retryAfterMs, safeText } from "./http";
import { ProviderError, type ModelTransport, type ModelTransportRequest, type ModelTransportResponse } from "./transport";

/**
 * Z.AI (GLM), as a transport.
 *
 * The third provider behind the same seam as Gemini and OpenRouter, and the one that sits in the
 * middle of the chain for a reason. The two free tiers fail in opposite directions: Gemini
 * answers a real extraction prompt in about three seconds and then hits a daily cap no waiting
 * reopens, while OpenRouter's free models keep going but take twenty-odd seconds. A GLM key is
 * neither — it is not drawn from either free bucket, and measured against the same real
 * extraction prompt `glm-5.3-flash` returned parseable JSON in about four seconds.
 *
 * So the order is Gemini → Z.AI → OpenRouter: spend the fastest thing first, fall to something
 * that is nearly as fast and independently metered, and keep the slow-but-durable free tier as
 * the floor. Nothing new is needed to arrange that — the gateway already walks a model list and
 * moves on when one reports itself unavailable, and `RoutedTransport` already sends each
 * `provider:model` name to the transport that understands it.
 *
 * The API is OpenAI-shaped, so this file and `openrouter.ts` look alike at the top and diverge
 * entirely at the bottom, where the error vocabulary and the reasoning budget live.
 */

export interface ZaiOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests. The suite never touches a real endpoint. */
  fetchImpl?: typeof fetch;
}

interface ZaiResponse {
  choices?: {
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** Z.AI's codes are decimal strings — `"1211"`, not `1211` — and do not track HTTP status. */
  error?: { message?: string; code?: number | string };
}

/**
 * GLM models, ranked on a real extraction prompt rather than a toy one.
 *
 * The same lesson openrouter.ts learned the hard way: a two-line prompt ranks these models in a
 * different order than a real one does, and the difference is the whole margin. Measured against
 * the Northwind full-stack posting, once each, with the reasoning budget negotiated as below:
 *
 *   glm-5.3-flash    ~4.2s   11 requirements, parseable first time
 *   glm-5.3          ~4.6s   11 requirements, marginally the richer evidence
 *   glm-4.6          ~9.3s   older family, kept as the tail — see the note on thinking below
 *
 * Deliberately absent: `glm-5-turbo`, which takes twenty seconds with its reasoning off and
 * fifty with it on, and `glm-4.5-flash`, which spends its entire output budget thinking and
 * returns an empty `content` with a full `reasoning_content`.
 *
 * `quality` leads with `glm-5.3` because extraction is the 20-point step and the two are within
 * half a second of each other; `fast` leads with the flash variant. Both keep `glm-4.6` last,
 * which also means the older-family branch of the negotiation below is exercised in production
 * rather than only in tests.
 *
 * This list will rot the way the last one did. `GET https://api.z.ai/api/paas/v4/models` lists
 * what the key can actually reach — check it before suspecting the pipeline.
 */
export const ZAI_QUALITY_MODELS = ["glm-5.3", "glm-5.3-flash", "glm-4.6"] as const;
export const ZAI_FAST_MODELS = ["glm-5.3-flash", "glm-5.3", "glm-4.6"] as const;

/** See DEFAULT_REQUEST_BUDGET_MS in gateway.ts, where the measurement behind this number is. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class ZaiTransport implements ModelTransport {
  readonly name = "zai";

  /**
   * Models known to reject `thinking: {type: "disabled"}`, learned at runtime.
   *
   * Per instance, never persisted, and only ever grows. See `#reasoningBudget` for why the
   * knob has to be negotiated at all; this is what keeps the negotiation to one wasted round
   * trip per model per process instead of one per call.
   */
  readonly #alwaysThinks = new Set<string>();

  constructor(private readonly options: ZaiOptions) {}

  async send(request: ModelTransportRequest): Promise<ModelTransportResponse> {
    try {
      return await this.#attempt(request, true);
    } catch (error) {
      // `response_format` is an optimisation, never a requirement — the gateway parses and
      // repairs the JSON itself either way. If a model rejects the hint, ask it again without
      // one rather than ending a run over a capability it never needed.
      if (!(error instanceof ProviderError) || !error.unsupportedFeature) throw error;
      return await this.#attempt(request, false);
    }
  }

  /**
   * Turning the reasoning budget down, which on this provider takes two incompatible knobs.
   *
   * Every GLM model here thinks before answering, and left alone that is the difference between
   * a usable provider and an unusable one: `glm-4.6` takes nine seconds with thinking off and
   * forty-four with it on, against a thirty-second per-request budget. It is not an accuracy
   * trade worth having either — the same prompt yielded the same requirement count both ways.
   *
   * The two model families disagree about how to say it, and neither accepts the other's word:
   *
   *   glm-4.x, glm-5-turbo   `thinking: {type: "disabled"}` works; `reasoning_effort` ignored
   *   glm-5.3, glm-5.3-flash `thinking: {type: "disabled"}` is a 400; `reasoning_effort` works
   *
   * So both are sent. `reasoning_effort` is harmless where it is ignored, and the `thinking`
   * field is dropped for any model that has already rejected it once. The rejection costs about
   * 850ms, arrives before any tokens are spent, and happens once per model per process — cheap
   * enough that discovering the family beats hardcoding a list of model names that will rot.
   */
  #reasoningBudget(model: string): Record<string, unknown> {
    return {
      reasoning_effort: "low",
      ...(this.#alwaysThinks.has(model) ? {} : { thinking: { type: "disabled" } }),
    };
  }

  async #attempt(request: ModelTransportRequest, structured: boolean): Promise<ModelTransportResponse> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    const base = (this.options.baseUrl ?? "https://api.z.ai/api/paas/v4").replace(/\/$/, "");

    let response: Response;
    try {
      response = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Bearer, not a query parameter, so the key cannot reach a log line.
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: "user", content: request.prompt }],
          ...(structured ? { response_format: { type: "json_object" } } : {}),
          temperature: 0.2,
          ...this.#reasoningBudget(request.model),
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A socket error is a blip worth retrying on the same model. A timeout means this model
      // has already had the whole request budget and produced nothing, and three more attempts
      // would cost a minute to end the same way while an untried model waits in the list.
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new ProviderError(`Z.AI request failed: ${describe(error)}`, {
        retryable: !timedOut,
        modelUnavailable: timedOut,
        cause: error,
      });
    }

    if (!response.ok) {
      const detail = await safeText(response);
      const code = codeFrom(detail);

      // The reasoning-budget rejection: this model always thinks. Remember it and ask again.
      if (isThinkingRejection(response.status, detail) && !this.#alwaysThinks.has(request.model)) {
        this.#alwaysThinks.add(request.model);
        return await this.#attempt(request, structured);
      }

      // A 400 here is not the usual "your request is malformed, and will be malformed again in
      // five seconds". Z.AI answers an unknown or withdrawn model with 400 + code 1211, which
      // is the one thing a status code cannot tell apart from a genuinely bad request — and
      // getting it wrong means a rotated model name fails the run instead of falling through to
      // the next name in the list.
      if (isModelUnavailable(response.status, code)) {
        throw new ProviderError(
          `Model "${request.model}" is not available on Z.AI right now (code ${code ?? response.status}). ` +
            `Set ZAI_MODELS in .env to one the key can reach — GET /api/paas/v4/models lists them. ` +
            `Provider said: ${detail}`,
          { status: response.status, retryable: false, modelUnavailable: true },
        );
      }

      // Out of credit or past a plan limit. Not retryable and not this model's fault: the whole
      // provider is spent, so every GLM name in the list will say the same thing and the chain
      // should reach OpenRouter as quickly as it can. Flagged unavailable to make that happen.
      if (isQuotaExhausted(response.status, code)) {
        throw new ProviderError(
          `Z.AI quota is exhausted (code ${code ?? response.status}). Falling through to the next provider. ` +
            `Provider said: ${detail}`,
          { status: response.status, retryable: false, modelUnavailable: true },
        );
      }

      throw new ProviderError(`Z.AI responded ${response.status}: ${detail}`, {
        status: response.status,
        // Concurrency and rate limits are the account's own and are worth waiting out.
        retryable: response.status === 429 || isRateLimit(code) || response.status >= 500,
        unsupportedFeature: structured && isUnsupportedFeature(response.status, detail),
        ...(retryAfterMs(response) !== undefined ? { retryAfterMs: retryAfterMs(response) as number } : {}),
      });
    }

    const payload = (await response.json()) as ZaiResponse;

    // An error body under a 200, the way OpenRouter reports an upstream failure mid-request.
    if (payload.error !== undefined) {
      const raw = JSON.stringify(payload.error);
      const code = typeof payload.error.code === "string" ? payload.error.code : String(payload.error.code ?? "");
      throw new ProviderError(`Z.AI error: ${payload.error.message ?? "unknown"}`, {
        retryable: isRateLimit(code),
        modelUnavailable: isModelUnavailable(400, code) || isQuotaExhausted(400, code),
        unsupportedFeature: structured && isUnsupportedFeature(400, raw),
      });
    }

    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? "";

    if (text.trim().length === 0) {
      // Empty content with a full `reasoning_content` is a specific, recoverable failure: the
      // model spent its entire output budget thinking and never started the answer. The next
      // model in the list has not made that mistake yet, so move on rather than retrying a
      // prompt that will produce the same thing.
      const thoughtInstead = (choice?.message?.reasoning_content ?? "").trim().length > 0;
      throw new ProviderError(
        thoughtInstead
          ? `Model "${request.model}" spent its whole output budget reasoning and returned no answer.`
          : `Z.AI returned no text (finish_reason: ${choice?.finish_reason ?? "none"})`,
        { retryable: false, modelUnavailable: thoughtInstead },
      );
    }

    return {
      text,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** The `error.code` out of an error body, as the decimal string the provider actually sends. */
function codeFrom(detail: string): string | undefined {
  try {
    const parsed = JSON.parse(detail) as ZaiResponse;
    if (parsed.error?.code === undefined) return undefined;
    return String(parsed.error.code);
  } catch {
    return undefined;
  }
}

/**
 * "This model always engages in thinking and cannot be disabled."
 *
 * Matched on the provider's words as well as its code, because 1210 is the generic invalid-
 * parameter code and a wrong `max_tokens` would carry it too. Narrow on purpose: a false
 * positive costs one retry with a slower model, a false negative costs every GLM-5.3 call.
 */
function isThinkingRejection(status: number, detail: string): boolean {
  if (status !== 400) return false;
  return /thinking.*cannot be disabled|always engages in thinking/i.test(detail);
}

/** 1211 unknown model, plus the statuses a withdrawn model is served with. */
function isModelUnavailable(status: number, code: string | undefined): boolean {
  if (status === 404 || status === 502 || status === 503) return true;
  return code === "1211" || code === "1212" || code === "1261";
}

/** 1112/1113 are the account-out-of-credit codes; 402 is the HTTP equivalent. */
function isQuotaExhausted(status: number, code: string | undefined): boolean {
  if (status === 402) return true;
  return code === "1112" || code === "1113";
}

/** 1302/1303/1304 are concurrency and per-key rate limits — the account's own, worth waiting out. */
function isRateLimit(code: string | undefined): boolean {
  return code === "1302" || code === "1303" || code === "1304" || code === "429";
}

/**
 * A 400 that means "this model cannot do that", not "your request is wrong". Currently one
 * thing: a model with no structured-output support rejecting `response_format`.
 */
function isUnsupportedFeature(status: number | undefined, detail: string): boolean {
  if (status !== 400) return false;
  if (isThinkingRejection(400, detail)) return false; // Handled on its own path, above.
  return /does not support feature|structured[-_ ]?outputs?|response_format/i.test(detail);
}
