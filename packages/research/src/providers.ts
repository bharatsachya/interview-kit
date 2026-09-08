import type { SearchOptions, SearchProvider, SearchResult } from "@trao/contracts";

/**
 * Search providers.
 *
 * Tavily: 1,000 credits a month, no card, and it returns page *content* rather than links, which
 * saves a fetch-and-clean round trip per result. Serper is the documented alternative — the step
 * is written against `SearchProvider`, so swapping is a wiring change. Brave's free tier was
 * withdrawn; do not reach for it.
 */

/**
 * What runs when there is no API key.
 *
 * The key is optional **by design**. No key produces empty results and a `skipped` step, never a
 * throw and never a branch: the wiring decides which provider exists, and the pipeline calls the
 * same code either way. A pipeline that said `if (hasKey)` would have two paths and one of them
 * would rot.
 */
export class NullSearchProvider implements SearchProvider {
  readonly name = "none";

  async search(): Promise<SearchResult[]> {
    return [];
  }
}

export interface TavilyOptions {
  apiKey: string;
  /** Injected for tests; no live network in the suite, ever. */
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

interface TavilyPayload {
  results?: { title?: string; url?: string; content?: string; score?: number }[];
}

export class TavilySearchProvider implements SearchProvider {
  readonly name = "tavily";

  constructor(private readonly options: TavilyOptions) {}

  async search(query: string, searchOptions: SearchOptions = {}): Promise<SearchResult[]> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    const response = await doFetch(this.options.endpoint ?? "https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.options.apiKey,
        query,
        max_results: searchOptions.maxResults ?? 5,
        search_depth: "basic",
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });

    if (!response.ok) throw new Error(`Tavily responded ${response.status}`);

    const payload = (await response.json()) as TavilyPayload;
    return (payload.results ?? [])
      .filter((result) => typeof result.url === "string")
      .map((result) => ({
        title: result.title ?? "",
        url: result.url as string,
        content: result.content ?? "",
        ...(result.score !== undefined ? { score: result.score } : {}),
      }));
  }
}
