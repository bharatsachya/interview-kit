/**
 * @trao/llm — the single gateway to a model provider, and the fakes that make the rest of the
 * build possible without an API key.
 *
 * Nothing outside this package may call a provider. One place to reason about rate limits,
 * retries, caching and malformed output; one place to test them.
 */

export {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  backoffDelay,
  retryDelay,
  type BackoffOptions,
} from "./backoff";
export { RunBudget, unlimitedBudget } from "./budget";
export { TokenBucket, perMinute } from "./bucket";
export {
  FakeLlmProvider,
  FakeTransport,
  rateLimited,
  type FakeLlmProviderOptions,
  type FakeResponder,
  type FakeResponse,
  type RecordedCall,
  type ScriptedStep,
} from "./fake";
export { RoutedTransport, isRouted } from "./routed";
export {
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_PROMPT_TOKENS,
  DEFAULT_OUTPUT_RESERVE,
  DEFAULT_REQUEST_BUDGET_MS,
  DEFAULT_RPM,
  DEFAULT_TPM,
  LlmGateway,
  promptHash,
  type LlmGatewayOptions,
} from "./gateway";
export { GeminiTransport, type GeminiOptions } from "./gemini";
export { OPENROUTER_FREE_MODELS, OpenRouterTransport, type OpenRouterOptions } from "./openrouter";
export { ZAI_FAST_MODELS, ZAI_QUALITY_MODELS, ZaiTransport, type ZaiOptions } from "./zai";
export { extractJson } from "./json";
export { MemoryCacheStore, NullCacheStore } from "./memory-cache";
export { DEFAULT_MAX_PAGE_CHARS, estimateTokens, truncateForPrompt, untrustedBlock } from "./tokens";
export {
  ProviderError,
  isRetryableStatus,
  type ModelTransport,
  type ModelTransportRequest,
  type ModelTransportResponse,
} from "./transport";
