import type { CacheStore, Clock } from "@trao/contracts";

/**
 * In-memory cache. The default for tests and for a single batch process.
 *
 * The file-backed one lands with the batch runner at H9, where surviving between runs is what
 * makes repeat development runs nearly free.
 */
export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, { value: unknown; expiresAt: number | null }>();

  constructor(private readonly clock: Clock) {}

  get size(): number {
    return this.#entries.size;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && this.clock.now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.#entries.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? null : this.clock.now() + ttlSeconds * 1000,
    });
  }
}

/** Never stores anything. What `--no-cache` wires in to prove a cold run works. */
export class NullCacheStore implements CacheStore {
  async get<T>(): Promise<T | null> {
    return null;
  }

  async set(): Promise<void> {
    // Intentionally nothing.
  }
}
