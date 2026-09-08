/**
 * Fetching pages and searching for public discussion.
 *
 * Two implementations of each are real: FakeFetcher over ./fixtures/sites vs the live fetcher,
 * and NullSearchProvider vs Tavily. The search key is optional by design — no key degrades to
 * a `skipped` step, it never throws and never branches the pipeline.
 */

export interface FetchOptions {
  timeoutMs?: number;
  /** Hard cap. An oversized page is rejected, not silently truncated. */
  maxBytes?: number;
}

export interface FetchResult {
  /** The URL asked for. */
  url: string;
  /** Where it ended up after redirects. Relative links resolve against this, not against `url`. */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
}

export interface HttpFetcher {
  fetch(url: string, options?: FetchOptions): Promise<FetchResult>;
}

export interface SearchResult {
  title: string;
  url: string;
  /** Page content when the provider returns it, saving a fetch-and-clean round trip. */
  content: string;
  score?: number;
}

export interface SearchOptions {
  maxResults?: number;
}

export interface SearchProvider {
  /** Reaches the trace as the `provider` attribute — "tavily" or "none". */
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}
