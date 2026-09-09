import type { SearchResult } from "@trao/contracts";

/**
 * Is this search result actually about the company we asked about?
 *
 * A live run searching for "Magica" came back with five results about Magic Software, Magic.dev
 * and generic interview advice. The brief writer noticed and said so in prose — but every one of
 * those URLs was still listed in `company_brief.sources`, which is a factual claim about what
 * this kit was built from. A source list that includes a different company is worse than a short
 * one.
 *
 * Names collide, and short names collide constantly. The filter is deliberately strict: a result
 * earns its place by naming the company or its domain, not by being adjacent to the topic.
 */

export interface RelevanceInput {
  company: string;
  /** The company's own site, when known. Its host is the strongest possible signal. */
  companyUrl?: string;
}

export interface RelevanceOutcome {
  kept: SearchResult[];
  dropped: { url: string; reason: "wrong_company" | "generic_advice" }[];
}

/**
 * Pages about interviewing in general, which match any company query and describe none.
 *
 * Matched against the host, not the content: "how to answer behavioural questions" on a careers
 * blog is not evidence about how this company hires, however well it scores for the query.
 */
const GENERIC_HOSTS =
  /(^|\.)(indeed|glassdoor|monster|ziprecruiter|linkedin|coursera|udemy|medium|quora|reddit|wikipedia|geeksforgeeks|leetcode|interviewbit|simplilearn|naukri|totaljobs|themuse)\./i;

/** Tokens too common to identify anyone. "Magic" alone should not match "Magica". */
function nameVariants(company: string): string[] {
  const trimmed = company.trim().toLowerCase();
  if (trimmed.length === 0) return [];

  const variants = new Set<string>([trimmed]);
  // "GalaxyAI Inc." also appears as "galaxyai" and "galaxy ai".
  const bare = trimmed.replace(/\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|plc|sa|bv|ab)\b\.?/g, "").trim();
  if (bare.length > 0) variants.add(bare);
  variants.add(bare.replace(/[^a-z0-9]+/g, ""));

  return [...variants].filter((v) => v.length >= 3);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The registrable-ish part of the company's own host: `galaxy` from `www.galaxy.ai`. */
function domainTokens(companyUrl: string | undefined): string[] {
  if (companyUrl === undefined) return [];
  const host = hostOf(companyUrl).replace(/^www\./, "");
  if (host === "") return [];
  return [host, ...host.split(".").filter((part) => part.length >= 3 && !/^(com|net|org|www|io|ai|co|dev|app)$/.test(part))];
}

export function filterRelevant(results: readonly SearchResult[], input: RelevanceInput): RelevanceOutcome {
  const names = nameVariants(input.company);
  const domains = domainTokens(input.companyUrl);
  const needles = [...new Set([...names, ...domains])];

  // Nothing to match on — keeping everything is more honest than dropping everything.
  if (needles.length === 0) return { kept: [...results], dropped: [] };

  const kept: SearchResult[] = [];
  const dropped: RelevanceOutcome["dropped"] = [];

  for (const result of results) {
    const host = hostOf(result.url);

    if (GENERIC_HOSTS.test(host) && !needles.some((needle) => host.includes(needle))) {
      dropped.push({ url: result.url, reason: "generic_advice" });
      continue;
    }

    // Whole-word for names, substring for hosts. Without the word boundary "magic" matches
    // "magica" and the collision this exists to catch slips straight through.
    const haystack = `${result.title} ${result.content}`.toLowerCase();
    const named = names.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(haystack));
    const hosted = needles.some((needle) => host.includes(needle) || result.url.toLowerCase().includes(needle));

    if (named || hosted) kept.push(result);
    else dropped.push({ url: result.url, reason: "wrong_company" });
  }

  return { kept, dropped };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
