import type { SearchProvider, SearchResult } from "@trao/contracts";

/**
 * Looking for what other people say about interviewing at a company.
 *
 * This step is **never fatal**. No key, a provider outage, a timeout, a malformed response — all
 * of them produce the same thing: no results, a recorded reason, and a brief that says the
 * public-discussion section is missing. That is a rung on the degradation ladder, not an error.
 */

export interface DiscussionSearchInput {
  company: string;
  roleTitle?: string;
  maxResults?: number;
}

export interface DiscussionSearchResult {
  provider: string;
  query: string;
  results: SearchResult[];
  /** Present when nothing was searched or the search failed. Goes straight into the span. */
  skippedReason?: "no_key" | "provider_error" | "no_company";
}

/**
 * The query is built in code, not by a model.
 *
 * One call, one shape. Asking a model to write a search query would cost a request from a
 * 250-a-day quota to produce something a template does as well.
 */
export function discussionQuery(input: DiscussionSearchInput): string {
  const parts = [input.company, "interview process", "engineering hiring"];
  if (input.roleTitle !== undefined && input.roleTitle.length > 0) parts.splice(1, 0, input.roleTitle);
  return parts.join(" ");
}

export async function searchDiscussion(
  provider: SearchProvider,
  input: DiscussionSearchInput,
): Promise<DiscussionSearchResult> {
  const query = discussionQuery(input);

  if (input.company.trim().length === 0) {
    return { provider: provider.name, query, results: [], skippedReason: "no_company" };
  }

  // The null provider identifies itself rather than being detected by a key check upstream.
  if (provider.name === "none") {
    return { provider: provider.name, query, results: [], skippedReason: "no_key" };
  }

  try {
    const results = await provider.search(query, { maxResults: input.maxResults ?? 5 });
    return { provider: provider.name, query, results };
  } catch {
    return { provider: provider.name, query, results: [], skippedReason: "provider_error" };
  }
}
