/**
 * The single seam to a model provider. Nothing outside packages/llm may implement or bypass it.
 */

/**
 * A validator, structurally. Zod schemas satisfy this as-is, which is how contracts stays free
 * of dependencies while the gateway still gets a real parse and a real error message to feed
 * back on the one JSON-repair retry.
 */
export interface OutputSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

/**
 * Which model to spend on. Requirement extraction is worth 20 points and gets `quality`;
 * everything else gets `fast`. Link ranking and schedule allocation get no model at all.
 */
export type LlmTier = "quality" | "fast";

export interface LlmRequest<T> {
  /** Short stable label — becomes the span name and part of the cache key. e.g. "extract_requirements". */
  purpose: string;
  prompt: string;
  schema: OutputSchema<T>;
  tier?: LlmTier;
  maxOutputTokens?: number;
  /** Skip the cache for this call. Used by `--no-cache` to prove a cold run works. */
  bypassCache?: boolean;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
  model: string;
  cacheHit: boolean;
  /** True when the first response failed the schema and the repair retry produced this one. */
  repaired: boolean;
}

export interface LlmProvider {
  readonly name: string;
  complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}
