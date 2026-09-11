import { ProviderError, type ModelTransport, type ModelTransportRequest, type ModelTransportResponse } from "./transport";

/**
 * OpenRouter, as a transport.
 *
 * A second provider behind the same seam as Gemini: raw text in, raw text out, no retrying, no
 * caching, no parsing. The gateway owns all of that, so nothing above this line knows or cares
 * which provider answered.
 *
 * Worth having for one practical reason. Gemini's free tier is a daily wall rather than a rate
 * limit — once it is spent, waiting minutes does nothing — and a day's UI work can exhaust it
 * before the pipeline has been exercised once. OpenRouter's free models are a different bucket,
 * so a spent Gemini quota stops being the end of the day's testing.
 *
 * The API is OpenAI-shaped, which is a happy accident rather than a design goal: it means this
 * file is also most of the work for any other OpenAI-compatible provider.
 */

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Sent as `HTTP-Referer` and `X-Title`. OpenRouter uses them for its public leaderboards and
   * for per-app rate accounting; both are optional and neither affects behaviour.
   */
  appUrl?: string;
  appName?: string;
  /** Injected for tests. The suite never touches a real endpoint. */
  fetchImpl?: typeof fetch;
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number | string };
}

/**
 * Free models on OpenRouter, in the order they are worth trying.
 *
 * The `:free` suffix is not decoration — it selects a zero-cost variant with its own, tighter
 * rate limits. These rotate as providers come and go, which is exactly why the gateway takes a
 * list: one model is out of capacity, and the next one answers.
 *
 * The previous four entries — deepseek-chat-v3-0324, llama-3.3-70b-instruct, qwen-2.5-72b-instruct
 * and gemma-3-27b-it — had all been retired, so the default was four models that no longer
 * existed and `OPENROUTER_MODELS` was mandatory without saying so. Each name below was probed
 * against the live API before being put here, and ordered by whether it returned parseable JSON
 * on repeated tries rather than by parameter count:
 *
 *   nex-n2.5-pro          clean JSON on every attempt
 *   ling-3.0-flash-vl     clean, and the fastest of them at well under two seconds
 *   laguna-s-2.1          clean
 *   nemotron-3-super      largest, but sometimes answers with its reasoning; the gateway's
 *                         repair round covers that, which is why it is last and not absent
 *
 * This list will rot the same way the last one did. When a kit comes back thin, check the models
 * endpoint before suspecting the pipeline.
 */
export const OPENROUTER_FREE_MODELS = [
  "nex-agi/nex-n2.5-pro:free",
  "inclusionai/ling-3.0-flash-vl:free",
  "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
] as const;

/** See the note in gemini.ts: sixty seconds is far too long to wait for a free model. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class OpenRouterTransport implements ModelTransport {
  readonly name = "openrouter";

  constructor(private readonly options: OpenRouterOptions) {}

  async send(request: ModelTransportRequest): Promise<ModelTransportResponse> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    const base = (this.options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

    let response: Response;
    try {
      response = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Bearer, not a query parameter, so the key cannot reach a log line.
          authorization: `Bearer ${this.options.apiKey}`,
          ...(this.options.appUrl !== undefined ? { "HTTP-Referer": this.options.appUrl } : {}),
          ...(this.options.appName !== undefined ? { "X-Title": this.options.appName } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: "user", content: request.prompt }],
          // Ask for JSON at the protocol level where the model supports it. The gateway still
          // parses and validates — this reduces how often the repair round is needed rather
          // than replacing it, and several free models ignore the hint entirely.
          response_format: { type: "json_object" },
          temperature: 0.2,
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A timeout or a socket error has no status. Worth one more try, so retryable.
      throw new ProviderError(`OpenRouter request failed: ${describe(error)}`, { retryable: true, cause: error });
    }

    if (!response.ok) {
      const detail = await safeText(response);

      // A free model that has been retired or is temporarily out of capacity. Flagged the same
      // way Gemini's is, so the gateway moves to the next model rather than failing the case.
      if (response.status === 404 || response.status === 502 || response.status === 503) {
        throw new ProviderError(
          `Model "${request.model}" is not available on OpenRouter right now. ` +
            `Free models rotate; set OPENROUTER_MODELS in .env to one that is. Provider said: ${detail}`,
          { status: response.status, retryable: false, modelUnavailable: true },
        );
      }

      throw new ProviderError(`OpenRouter responded ${response.status}: ${detail}`, {
        status: response.status,
        ...(retryAfterMs(response) !== undefined ? { retryAfterMs: retryAfterMs(response) as number } : {}),
      });
    }

    const payload = (await response.json()) as OpenRouterResponse;

    // OpenRouter returns 200 with an error body when an upstream provider fails mid-request.
    //
    // A 429 *here* is not the same as a 429 in the HTTP status. The status carries the account's
    // own rate limit, which is waited out. This carries the upstream provider's — a free model
    // that is out of capacity or has been quietly retired — and waiting does not help, because
    // nothing about this account changes when it clears. Every retired free model in this file's
    // original fallback list reports itself exactly this way, which is how a four-model chain
    // came to be inert: the gateway only moved on for 503 and 404, and it never saw either.
    if (payload.error !== undefined) {
      const status = typeof payload.error.code === "number" ? payload.error.code : undefined;
      const upstreamOutOfCapacity = status === 429 || status === 502 || status === 503;
      throw new ProviderError(`OpenRouter error: ${payload.error.message ?? "unknown"}`, {
        ...(status !== undefined ? { status } : {}),
        // Not retryable and not the account's problem: try the next model instead of sleeping.
        retryable: upstreamOutOfCapacity ? false : status === undefined || status >= 500,
        modelUnavailable: upstreamOutOfCapacity,
      });
    }

    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? "";

    if (text.trim().length === 0) {
      // A refusal or a truncation. Not retryable — the same prompt gets the same answer.
      throw new ProviderError(`OpenRouter returned no text (finish_reason: ${choice?.finish_reason ?? "none"})`, {
        retryable: false,
      });
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

/** `Retry-After` in seconds or as a date. Honoured over the backoff schedule when present. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;

  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const asDate = Date.parse(header);
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "(no body)";
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timed out" : error.message;
  return String(error);
}
