import type { Clock, FetchResult, HttpFetcher } from "@trao/contracts";
import { candidatesFromHtml, mergeCandidates } from "./discovery";
import { cleanText, pageTitle } from "./html";
import { rankLinks, type ScoredLink, type ScorerKind } from "./ranking";
import { ALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from "./robots";
import { discoverFromSitemaps } from "./sitemap";
import { isSameRegistrableSite, normaliseUrl } from "./url";

/**
 * Crawl of one company site: discover everything, score everything, fetch a few.
 *
 * Budgets, all deliberate: 8 pages, depth 2, 5-second request timeout, 500KB per page, about 2
 * requests a second. A company site is background material for a study kit, not a dataset.
 *
 * ## Discover, then score, then filter
 *
 * The order matters and it used to be wrong. A live crawl of galaxy.ai found five links,
 * discarded four as external before scoring anything, and reported the site had no careers page.
 * It had one — the discarded links included it, on an applicant tracking system. Filtering by
 * domain before scoring throws away the answer without ever looking at it.
 *
 * So every source is merged first — anchors, sitemaps, framework route tables, JSON-LD — every
 * candidate is scored, and only then does anything decide what to fetch.
 *
 * ## Two lists, not one
 *
 * A kit needs to know what the company does *and* how it interviews. One ranked list gives two
 * of whichever scores higher and none of the other, which is how a brief ends up describing a
 * product in detail and saying nothing about the process. Top three from each.
 *
 * A page that cannot be retrieved is skipped and reported. One 404 never fails a crawl, and a
 * crawl that finds nothing never fails a run: it produces an honest brief that says so.
 */

export const DEFAULT_MAX_PAGES = 8;
export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_BYTES = 500 * 1024;
export const DEFAULT_REQUESTS_PER_SECOND = 2;
export const DEFAULT_PER_SCORER = 3;
export const USER_AGENT = "TraoInterviewKitBot";

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  depth: number;
  score: number;
  /** Which scorer chose this page. */
  kind: ScorerKind | "homepage";
  /** True when the page lives on a domain other than the company's own. */
  external: boolean;
}

export type SkipReason =
  | "robots"
  | "http_error"
  | "too_large"
  | "wrong_content_type"
  | "fetch_failed"
  | "budget"
  | "external_not_followed";

export interface SkippedUrl {
  url: string;
  reason: SkipReason;
  detail?: string;
}

/** What happened to a scored candidate. Reported per scorer, for the trace. */
export type LinkOutcome =
  | "fetched"
  | "external_followed"
  | "skipped_budget"
  | "blocked_robots"
  | "failed"
  | "not_selected";

export interface RankedReport {
  url: string;
  score: number;
  reasons: string[];
  outcome: LinkOutcome;
}

export interface CrawlResult {
  pages: CrawledPage[];
  skipped: SkippedUrl[];
  /** Everything discovered, before any filtering. */
  linksFound: number;
  linksScored: number;
  robotsBlocked: number;
  /** URLs the site declared in its own sitemap. Zero is normal; it is how a SPA stays readable. */
  sitemapUrls: number;
  sitemapsFetched: string[];
  /** How many candidates each source contributed, so a SPA is legible in the trace. */
  bySource: Record<string, number>;
  /** True when the hiring material was found on someone else's domain. */
  hiringPageExternal: boolean;
  /** Top five per scorer, with score and outcome. */
  topLinks: Record<ScorerKind, RankedReport[]>;
}

export interface CrawlOptions {
  fetcher: HttpFetcher;
  clock: Clock;
  maxPages?: number;
  maxDepth?: number;
  timeoutMs?: number;
  maxBytes?: number;
  requestsPerSecond?: number;
  /** How many to fetch from each ranked list. */
  perScorer?: number;
  /** Fetched once per site. A missing or unparseable file means allow. */
  robotsTxt?: string | null;
  useSitemap?: boolean;
  /** Follow a high-scoring hiring link to another domain, one hop. On by default. */
  followExternalHiring?: boolean;
  /** A link must score at least this to be worth leaving the site for. */
  externalHiringThreshold?: number;
}

export const DEFAULT_EXTERNAL_HIRING_THRESHOLD = 18;

export async function crawlSite(homepage: FetchResult, options: CrawlOptions): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const perScorer = options.perScorer ?? DEFAULT_PER_SCORER;
  const minIntervalMs = 1000 / (options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND);
  const externalThreshold = options.externalHiringThreshold ?? DEFAULT_EXTERNAL_HIRING_THRESHOLD;

  const robots: RobotsRules =
    options.robotsTxt != null && options.robotsTxt.length > 0 ? parseRobots(options.robotsTxt, USER_AGENT) : ALLOW_ALL;

  const origin = new URL(homepage.finalUrl).origin;
  const skipped: SkippedUrl[] = [];
  const visited = new Set<string>([normaliseUrl(homepage.finalUrl)]);

  const pages: CrawledPage[] = [
    {
      url: homepage.finalUrl,
      title: pageTitle(homepage.body),
      text: cleanText(homepage.body),
      depth: 0,
      score: Number.POSITIVE_INFINITY,
      kind: "homepage",
      external: false,
    },
  ];

  // ── Discover: everything, from everywhere, before anything is judged ────────────────────
  let candidates = candidatesFromHtml(homepage.body, homepage.finalUrl);

  let sitemap = { urls: [] as string[], fetched: [] as string[] };
  if (options.useSitemap !== false) {
    sitemap = await discoverFromSitemaps({
      fetcher: options.fetcher,
      baseUrl: homepage.finalUrl,
      robotsTxt: options.robotsTxt ?? null,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });
    candidates = mergeCandidates(
      candidates,
      sitemap.urls.map((url) => ({ url, anchor: "", position: "unknown" as const, source: "sitemap" as const })),
    );
  }

  candidates = candidates.filter((candidate) => !visited.has(normaliseUrl(candidate.url)));

  const bySource: Record<string, number> = {};
  for (const candidate of candidates) bySource[candidate.source] = (bySource[candidate.source] ?? 0) + 1;

  // ── Score: both scorers, over everything, including other domains ──────────────────────
  const ranked: Record<ScorerKind, ScoredLink[]> = {
    about: rankLinks(candidates, "about", { origin }),
    hiring: rankLinks(candidates, "hiring", { origin }),
  };

  // ── Select: top N per list, interleaved so neither starves the other ───────────────────
  const outcomes = new Map<string, LinkOutcome>();
  const selection: { link: ScoredLink; kind: ScorerKind }[] = [];
  const claimed = new Set<string>();

  for (let rank = 0; rank < perScorer; rank += 1) {
    for (const kind of ["hiring", "about"] as const) {
      const link = ranked[kind].filter((l) => !claimed.has(normaliseUrl(l.url)))[0];
      if (link === undefined || link.score <= 0) continue;

      const key = normaliseUrl(link.url);
      const sameSite = !link.external || isSameRegistrableSite(link.url, homepage.finalUrl);

      if (!sameSite) {
        // One hop, and only for a link that is clearly about hiring. An ATS host alone clears
        // the threshold; a random outbound link does not.
        const worthLeavingFor =
          kind === "hiring" && options.followExternalHiring !== false && link.score >= externalThreshold;
        if (!worthLeavingFor) {
          outcomes.set(key, "not_selected");
          skipped.push({ url: link.url, reason: "external_not_followed", detail: `score ${link.score}` });
          claimed.add(key);
          continue;
        }
      }

      claimed.add(key);
      selection.push({ link, kind });
    }
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────────────────
  let hiringPageExternal = false;
  let lastRequestAt = options.clock.now();

  for (const { link, kind } of selection) {
    const key = normaliseUrl(link.url);
    if (pages.length >= maxPages) {
      outcomes.set(key, "skipped_budget");
      skipped.push({ url: link.url, reason: "budget" });
      continue;
    }

    const sameSite = !link.external || isSameRegistrableSite(link.url, homepage.finalUrl);

    // robots.txt governs the site it belongs to. Ours is already parsed; another host's is not
    // fetched — one hop to a page a company deliberately linked to is not a crawl of that host,
    // and spending a request on their robots to read one page they advertised is disproportionate.
    if (sameSite && !isAllowed(robots, new URL(link.url).pathname)) {
      outcomes.set(key, "blocked_robots");
      skipped.push({ url: link.url, reason: "robots" });
      continue;
    }

    const sinceLast = options.clock.now() - lastRequestAt;
    if (sinceLast < minIntervalMs) await options.clock.sleep(minIntervalMs - sinceLast);
    lastRequestAt = options.clock.now();

    let result: FetchResult;
    try {
      result = await options.fetcher.fetch(link.url, {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      });
    } catch (error) {
      outcomes.set(key, "failed");
      skipped.push({ url: link.url, reason: reasonFor(error), detail: message(error) });
      continue;
    }

    if (result.status >= 400) {
      outcomes.set(key, "failed");
      skipped.push({ url: link.url, reason: "http_error", detail: String(result.status) });
      continue;
    }
    if (!result.contentType.includes("html")) {
      outcomes.set(key, "failed");
      skipped.push({ url: link.url, reason: "wrong_content_type", detail: result.contentType });
      continue;
    }

    visited.add(normaliseUrl(result.finalUrl));
    outcomes.set(key, sameSite ? "fetched" : "external_followed");
    if (!sameSite && kind === "hiring") hiringPageExternal = true;

    pages.push({
      url: result.finalUrl,
      title: pageTitle(result.body),
      text: cleanText(result.body),
      depth: 1,
      score: link.score,
      kind,
      external: !sameSite,
    });
  }

  void maxDepth; // One hop from the homepage; depth 2 is the sitemap and framework routes.

  return {
    pages,
    skipped,
    linksFound: candidates.length,
    linksScored: candidates.length,
    robotsBlocked: skipped.filter((s) => s.reason === "robots").length,
    sitemapUrls: sitemap.urls.length,
    sitemapsFetched: sitemap.fetched,
    bySource,
    hiringPageExternal,
    topLinks: {
      hiring: report(ranked.hiring, outcomes),
      about: report(ranked.about, outcomes),
    },
  };
}

function report(links: readonly ScoredLink[], outcomes: ReadonlyMap<string, LinkOutcome>): RankedReport[] {
  return links.slice(0, 5).map((link) => ({
    url: link.url,
    score: link.score,
    reasons: link.reasons,
    outcome: outcomes.get(normaliseUrl(link.url)) ?? "not_selected",
  }));
}

function reasonFor(error: unknown): SkipReason {
  const text = message(error).toLowerCase();
  if (text.includes("too large") || text.includes("exceeds")) return "too_large";
  if (text.includes("content type")) return "wrong_content_type";
  return "fetch_failed";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
