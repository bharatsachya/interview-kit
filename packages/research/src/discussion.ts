import type { SearchProvider, SearchResult } from "@trao/contracts";
import { filterRelevant, type RelevanceOutcome } from "./relevance";

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
  /**
   * The company's own site. Its domain goes into the query and is the strongest relevance
   * signal afterwards — company names collide, hosts do not.
   */
  companyUrl?: string;
  maxResults?: number;
}

export interface DiscussionSearchResult {
  provider: string;
  query: string;
  results: SearchResult[];
  /** Present when nothing was searched or the search failed. Goes straight into the span. */
  skippedReason?: "no_key" | "provider_error" | "no_company";
  /**
   * Results the provider returned that were not about this company.
   *
   * Reported rather than silently discarded: "we searched and found five things, four of which
   * were about someone else" is a different fact from "we found one thing", and the brief's
   * `sources` list is a factual claim about what the kit was built from.
   */
  filtered: RelevanceOutcome["dropped"];
}

/**
 * The query is built in code, not by a model.
 *
 * One call, one shape. Asking a model to write a search query would cost a request from a
 * 250-a-day quota to produce something a template does as well.
 */
export function discussionQuery(input: DiscussionSearchInput): string {
  const parts = [input.company];
  if (input.roleTitle !== undefined && input.roleTitle.length > 0) parts.push(input.roleTitle);

  // The domain disambiguates a name that collides. Searching "Magica interview process" returned
  // Magic Software and Magic.dev; "Magica galaxy.ai interview process" does not.
  const host = hostOf(input.companyUrl);
  if (host !== "") parts.push(host);

  parts.push("interview process", "engineering hiring");
  return parts.join(" ");
}

function hostOf(url: string | undefined): string {
  if (url === undefined) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function searchDiscussion(
  provider: SearchProvider,
  input: DiscussionSearchInput,
): Promise<DiscussionSearchResult> {
  const query = discussionQuery(input);

  if (input.company.trim().length === 0) {
    return { provider: provider.name, query, results: [], filtered: [], skippedReason: "no_company" };
  }

  // The null provider identifies itself rather than being detected by a key check upstream.
  if (provider.name === "none") {
    return { provider: provider.name, query, results: [], filtered: [], skippedReason: "no_key" };
  }

  try {
    const raw = await provider.search(query, { maxResults: input.maxResults ?? 5 });
    const { kept, dropped } = filterRelevant(raw, {
      company: input.company,
      ...(input.companyUrl !== undefined ? { companyUrl: input.companyUrl } : {}),
    });
    return { provider: provider.name, query, results: kept, filtered: dropped };
  } catch {
    return { provider: provider.name, query, results: [], filtered: [], skippedReason: "provider_error" };
  }
}
