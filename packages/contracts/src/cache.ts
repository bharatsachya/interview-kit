/**
 * Cache.
 *
 * Not an optimisation. Gemini's free tier caps requests per day well before it caps tokens per
 * minute, so without a cache a development day allows roughly six full batch runs. Two
 * implementations: in-memory for tests, file-backed for batch and dev.
 */

export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  /** `ttlSeconds` omitted means no expiry. */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
}
