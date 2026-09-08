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
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      // A timeout or a socket error has no status. Worth one more try, so retryable.
      throw new ProviderError(`Gemini request failed: ${describe(error)}`, { retryable: true, cause: error });
    }

    if (!response.ok) {
      const detail = await safeText(response);
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
