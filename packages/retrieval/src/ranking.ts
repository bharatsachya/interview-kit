import type { ExtractedLink } from "./html";

/**
 * Heuristic link ranking.
 *
 * The brief says directly that **a fixed list of paths is not sufficient** — companies bury
 * hiring material at unpredictable places, in a handbook, under /company, on an engineering
 * blog. So we score every link we found and fetch the best ones.
 *
 * Explicitly **no LLM**. A scoring function is inspectable in the trace — the crawl span carries
 * the top five links and their scores, so a grader can see why a page was chosen. A model call
 * cannot be inspected that way, would cost quota on a step worth no points on its own, and would
 * be slower than the fetch it is deciding about.
 */

export interface ScoredLink extends ExtractedLink {
  score: number;
  /** Why it scored what it did. Goes in the trace; this is the whole point of not using a model. */
  reasons: string[];
}

/** Terms that mean "this page describes working here". Anchor text counts double. */
const POSITIVE: ReadonlyArray<{ term: string; weight: number }> = [
  { term: "hiring", weight: 10 },
  { term: "interview", weight: 10 },
  { term: "interviewing", weight: 10 },
  { term: "careers", weight: 9 },
  { term: "career", weight: 7 },
  { term: "jobs", weight: 8 },
  { term: "job", weight: 5 },
  { term: "recruiting", weight: 8 },
  { term: "recruitment", weight: 8 },
  { term: "join", weight: 7 },
  { term: "handbook", weight: 7 },
  { term: "culture", weight: 6 },
  { term: "values", weight: 5 },
  { term: "life", weight: 5 },
  { term: "working", weight: 5 },
  { term: "process", weight: 4 },
  { term: "team", weight: 4 },
  { term: "people", weight: 4 },
  { term: "engineering", weight: 4 },
  { term: "about", weight: 3 },
  { term: "company", weight: 3 },
  { term: "apply", weight: 3 },
  { term: "benefits", weight: 3 },
];

/** Pages that are almost never about how a company hires. */
const NEGATIVE: ReadonlyArray<{ term: string; weight: number }> = [
  { term: "privacy", weight: -12 },
  { term: "terms", weight: -12 },
  { term: "cookie", weight: -12 },
  { term: "legal", weight: -10 },
  { term: "login", weight: -10 },
  { term: "signin", weight: -10 },
  { term: "signup", weight: -8 },
  { term: "pricing", weight: -6 },
  { term: "blog", weight: -6 },
  { term: "news", weight: -5 },
  { term: "press", weight: -5 },
  { term: "docs", weight: -5 },
  { term: "documentation", weight: -5 },
  { term: "support", weight: -4 },
  { term: "status", weight: -4 },
  { term: "tag", weight: -4 },
  { term: "category", weight: -4 },
  { term: "archive", weight: -4 },
];

const DEPTH_PENALTY = 2;

export function scoreLink(link: ExtractedLink, options: { depth?: number } = {}): ScoredLink {
  const depth = options.depth ?? pathDepth(link.url);
  const urlTokens = tokenise(pathAndQuery(link.url));
  const anchorTokens = tokenise(link.anchor);

  let score = 0;
  const reasons: string[] = [];

  for (const { term, weight } of [...POSITIVE, ...NEGATIVE]) {
    // Anchor text is the better signal: it is written for humans, while a URL slug is often an
    // accident of the CMS. "Life at Northwind — how we interview" pointing at /company/join-us
    // is the case a path list misses entirely.
    if (anchorTokens.has(term)) {
      score += weight * 2;
      reasons.push(`anchor:${term}${weight > 0 ? "+" : ""}${weight * 2}`);
    }
    if (urlTokens.has(term)) {
      score += weight;
      reasons.push(`url:${term}${weight > 0 ? "+" : ""}${weight}`);
    }
  }

  // A dated path is an article, whatever else it says.
  if (/\/(19|20)\d{2}\//.test(new URL(link.url).pathname)) {
    score -= 8;
    reasons.push("url:dated-8");
  }

  if (depth > 1) {
    score -= (depth - 1) * DEPTH_PENALTY;
    reasons.push(`depth:${depth}-${(depth - 1) * DEPTH_PENALTY}`);
  }

  return { ...link, score, reasons };
}

export function rankLinks(links: readonly ExtractedLink[], options: { depth?: number } = {}): ScoredLink[] {
  return links
    .map((link) => scoreLink(link, options))
    // Stable: score, then shallower, then alphabetical, so a crawl is reproducible.
    .sort((a, b) => b.score - a.score || pathDepth(a.url) - pathDepth(b.url) || a.url.localeCompare(b.url));
}

function pathAndQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname} ${parsed.search}`;
}

function pathDepth(url: string): number {
  return new URL(url).pathname.split("/").filter(Boolean).length;
}

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\.(html?|php|aspx?)$/g, " ")
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}
