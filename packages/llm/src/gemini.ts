import { ProviderError, type ModelTransport, type ModelTransportRequest, type ModelTransportResponse } from "./transport";

/**
 * Gemini, as a transport.
 *
 * Raw text in, raw text out. No retrying, no caching, no parsing — the gateway owns all of that,
 * and a transport that retried on its own would be spending requests the token buckets never
 * accounted for.
 *
 * Everything provider-specific is confined to this file: the URL shape, the header the key goes
 * in, the response envelope, and how a rate limit is reported. Swapping providers is one new
 * class and one line in `scripts/composition.ts`.
 */

export interface GeminiOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests. The suite never touches a real endpoint. */
  fetchImpl?: typeof fetch;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
}

/**
 * A free-tier model that has not answered in this long is not about to.
 *
 * Was sixty seconds, which combined with four retries and a three-model fallback list gave a
 * twelve-minute worst case for one step — a run that looked hung because it effectively was.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class GeminiTransport implements ModelTransport {
  readonly name = "gemini";

  constructor(private readonly options: GeminiOptions) {}

  async send(request: ModelTransportRequest): Promise<ModelTransportResponse> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    const base = this.options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const url = `${base}/models/${encodeURIComponent(request.model)}:generateContent`;

    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header rather than a query parameter, so the key cannot end up in a log line.
          "x-goog-api-key": this.options.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig: {
            // Ask for JSON at the protocol level. The gateway still parses and validates —
            // this reduces how often the repair round is needed, it does not replace it.
            responseMimeType: "application/json",
            temperature: 0.2,
            ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
          },
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A timeout or a socket error has no status. Worth one more try, so retryable.
      throw new ProviderError(`Gemini request failed: ${describe(error)}`, { retryable: true, cause: error });
    }

    if (!response.ok) {
      const detail = await safeText(response);

      // A retired model is a 404 that reads like a bug in our URL. Google removes numbered
      // models for newly issued keys, so `gemini-2.5-flash` works for one developer and 404s
      // for the next — worth naming explicitly rather than leaving someone to read the raw
      // body and guess.
      if (response.status === 404 && /no longer available|not found for API version/i.test(detail)) {
        throw new ProviderError(
          `Model "${request.model}" is not available to this API key. ` +
            `Set GEMINI_MODEL_QUALITY / GEMINI_MODEL_FAST in .env to a model the key can use — ` +
            `the floating aliases gemini-flash-latest and gemini-flash-lite-latest are the safe default. ` +
            `Provider said: ${detail}`,
          { status: 404, retryable: false },
        );
      }

      throw new ProviderError(`Gemini responded ${response.status}: ${detail}`, {
        status: response.status,
        ...(retryAfterMs(response) !== undefined ? { retryAfterMs: retryAfterMs(response) as number } : {}),
      });
    }

    const payload = (await response.json()) as GeminiResponse;
    if (payload.error !== undefined) {
      throw new ProviderError(`Gemini error: ${payload.error.message ?? payload.error.status ?? "unknown"}`);
    }

    const candidate = payload.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? "").join("");

    if (text.trim().length === 0) {
      // A safety block or a truncation. Not retryable — the same prompt gets the same refusal.
      throw new ProviderError(`Gemini returned no text (finishReason: ${candidate?.finishReason ?? "none"})`, {
        retryable: false,
      });
    }

    return {
      text,
      usage: {
        inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}

/**
 * `Retry-After` in seconds, or Google's `retryDelay` in the error body shape ("42s").
 *
 * Honoured over the backoff schedule because the provider is the only party that knows when the
 * quota window actually reopens.
 */
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
