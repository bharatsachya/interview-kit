import { createHash } from "node:crypto";
import {
  KitError,
  type Budget,
  type CacheStore,
  type Clock,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmTier,
  type SpanHandle,
  type Tracer,
} from "@trao/contracts";
import { retryDelay, type BackoffOptions } from "./backoff";
import { perMinute, TokenBucket } from "./bucket";
import { extractJson } from "./json";
import { estimateTokens } from "./tokens";
import { ProviderError, type ModelTransport } from "./transport";

/**
 * The one gateway. Nothing else in the repo touches a model provider.
 *
 * Order of operations, and why each step is where it is:
 *
 *   1. **Cache** — before anything is spent. On the free tier, requests-per-day runs out long
 *      before tokens-per-minute does; without a cache a development day allows about six full
 *      batch runs. The cache is not an optimisation, it is what makes the day possible.
 *   2. **Budget** — checked before queueing, so an exhausted run fails fast instead of waiting
 *      in line for a call it is not allowed to make.
 *   3. **Buckets** — RPM and TPM, both acquired before the request goes out. Requests wait
 *      rather than fire and fail.
 *   4. **Send, with retries** — `Retry-After` when the provider sends it, exponential backoff
 *      with jitter otherwise.
 *   5. **Parse** — local JSON extraction first because it is free, then the schema.
 *   6. **Repair** — exactly one retry, with the validation error fed back. Then fail cleanly and
 *      let the caller record a skipped step.
 */

export interface LlmGatewayOptions {
  transport: ModelTransport;
  cache: CacheStore;
  clock: Clock;
  tracer: Tracer;
  budget: Budget;
  /**
   * Which model each tier maps to. Requirement extraction is worth 20 points and asks for
   * `quality`; everything else takes `fast`. Link ranking and schedule allocation ask for
   * neither, because they never call a model at all.
   */
  models: Record<LlmTier, string>;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxAttempts?: number;
  cacheTtlSeconds?: number;
  backoff?: BackoffOptions;

  /**
   * Record the prompt and the raw response on each call's span.
   *
   * Off by default, and it should stay off in production: prompts contain the pasted job
   * description and whole fetched pages, so a trace with this on is a copy of the user's input
   * sitting in a log. On for `--record-prompts`, where the point is to read exactly what was
   * sent and exactly what came back.
   */
  recordPrompts?: boolean;
  /** Cap on each recorded string, so one trace cannot be fifty megabytes. */
  recordedPromptChars?: number;
}

/** Gemini's free tier sits around 10-15 RPM and 250,000 TPM. Stay under, not level with. */
export const DEFAULT_RPM = 10;
export const DEFAULT_TPM = 250_000;
export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
/** Output allowance reserved when the caller does not cap it. */
export const DEFAULT_OUTPUT_RESERVE = 1_024;

interface CachedResponse {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export class LlmGateway implements LlmProvider {
  readonly name: string;
  readonly #rpm: TokenBucket;
  readonly #tpm: TokenBucket;
  readonly #maxAttempts: number;
  readonly #cacheTtl: number;

  constructor(private readonly options: LlmGatewayOptions) {
    this.name = options.transport.name;
    this.#rpm = perMinute(options.requestsPerMinute ?? DEFAULT_RPM, options.clock);
    this.#tpm = perMinute(options.tokensPerMinute ?? DEFAULT_TPM, options.clock);
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#cacheTtl = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  }

  complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    return this.options.tracer.span(`llm:${request.purpose}`, (span) => this.#run(request, span));
  }

  async #run<T>(request: LlmRequest<T>, span: SpanHandle): Promise<LlmResult<T>> {
    const model = this.options.models[request.tier ?? "fast"];
    const hash = promptHash(model, request.prompt);
    const inputTokens = estimateTokens(request.prompt);

    span.setAll({
      model,
      prompt_hash: hash.slice(0, 12),
      input_tokens: inputTokens,
      cache_hit: false,
      queued_ms: 0,
      attempt: 0,
      rate_limited: false,
      repair_attempted: false,
    });

    // 1. Cache.
    if (request.bypassCache !== true) {
      const cached = await this.options.cache.get<CachedResponse>(cacheKey(hash));
      if (cached !== null) {
        const parsed = this.#parse(request.schema, cached.text);
        // A cached response that no longer fits the schema means the schema changed under it.
        // Treat it as a miss rather than failing a run over a stale entry.
        if (parsed.ok) {
          span.setAll({ cache_hit: true, output_tokens: cached.usage.outputTokens });
          return { data: parsed.value, usage: cached.usage, model: cached.model, cacheHit: true, repaired: false };
        }
      }
    }

    // 2-6. A repair is a second real request: it reserves budget again and queues again.
    let prompt = request.prompt;
    let repaired = false;
    let queuedMs = 0;

    for (let round = 0; round < 2; round += 1) {
      const promptTokens = round === 0 ? inputTokens : estimateTokens(prompt);

      // Budget is reserved *before* the call, not charged after it. A request that has gone out
      // has been paid for whatever we record afterwards, so charging on the way back would
      // either throw away a response we already bought or under-count the ones we keep.
      // Reserving the output allowance too errs towards stopping early, which is the safe
      // direction when the daily quota is the scarce thing.
      this.options.budget.spend(promptTokens + (request.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE));

      queuedMs += (await this.#rpm.acquire(1)) + (await this.#tpm.acquire(promptTokens));
      span.set("queued_ms", queuedMs);

      const response = await this.#send(
        { model, prompt, ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}) },
        span,
      );
      const usage = response.usage ?? { inputTokens: promptTokens, outputTokens: estimateTokens(response.text) };
      span.set("output_tokens", usage.outputTokens);

      if (this.options.recordPrompts === true) {
        const cap = this.options.recordedPromptChars ?? 8_000;
        span.setAll({
          [round === 0 ? "prompt" : "repair_prompt"]: clip(prompt, cap),
          [round === 0 ? "response" : "repair_response"]: clip(response.text, cap),
        });
      }

      const parsed = this.#parse(request.schema, response.text);
      if (parsed.ok) {
        // Cached under the ORIGINAL prompt hash, so the next identical request skips the repair
        // round entirely rather than repeating the mistake and correcting it again.
        await this.options.cache.set<CachedResponse>(cacheKey(hash), { text: response.text, model, usage }, this.#cacheTtl);
        return { data: parsed.value, usage, model, cacheHit: false, repaired };
      }

      if (round === 1) {
        throw new KitError("INVALID_MODEL_OUTPUT", `${request.purpose}: model output failed validation twice.`, {
          details: { error: parsed.error, purpose: request.purpose },
        });
      }

      // Exactly one repair, with the validation error fed back so the retry has something to act
      // on. A second repair on the same quota would be optimism, not engineering.
      span.setAll({ repair_attempted: true, repair_reason: parsed.error });
      repaired = true;
      prompt = repairPrompt(request.prompt, parsed.error);
    }

    /* c8 ignore next */
    throw new KitError("INTERNAL", "unreachable: repair loop fell through");
  }

  async #send(request: { model: string; prompt: string; maxOutputTokens?: number }, span: SpanHandle) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      span.set("attempt", attempt);
      try {
        return await this.options.transport.send(request);
      } catch (error) {
        lastError = error;
        const providerError = error instanceof ProviderError ? error : undefined;
        if (providerError !== undefined && !providerError.retryable) break;
        if (attempt === this.#maxAttempts) break;

        if (providerError?.status === 429) span.set("rate_limited", true);
        const delay = retryDelay(attempt, providerError?.retryAfterMs, this.options.backoff);
        span.set("last_retry_delay_ms", delay);
        await this.options.clock.sleep(delay);
      }
    }

    throw new KitError("LLM_UNAVAILABLE", describe(lastError), {
      retryable: true,
      cause: lastError,
      details: { attempts: this.#maxAttempts },
    });
  }

  #parse<T>(
    schema: LlmRequest<T>["schema"],
    text: string,
  ): { ok: true; value: T } | { ok: false; error: string } {
    let candidate: unknown;
    try {
      candidate = extractJson(text);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const result = schema.safeParse(candidate);
    return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message };
  }
}

/** sha256 of model + prompt. Same question to the same model is the same answer. */
export function promptHash(model: string, prompt: string): string {
  return createHash("sha256").update(model).update(" ").update(prompt).digest("hex");
}

function cacheKey(hash: string): string {
  return `llm:${hash}`;
}

function repairPrompt(original: string, error: string): string {
  return [
    original,
    "",
    "Your previous response was rejected by the schema validator:",
    error,
    "",
    "Return only the corrected JSON. No prose, no code fences, no explanation.",
  ].join("\n");
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[${text.length - max} more characters]`;
}
