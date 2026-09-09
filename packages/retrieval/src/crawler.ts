import type { Clock, FetchResult, HttpFetcher } from "@trao/contracts";
import { cleanText, extractLinks, isSameSite, pageTitle } from "./html";
import { ALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from "./robots";
import { rankLinks, type ScoredLink } from "./ranking";
import { discoverFromSitemaps } from "./sitemap";

/**
 * Best-first crawl of one company site.
 *
 * Budgets, all of them deliberate: 8 pages, depth 2, 5-second request timeout, 500KB per page,
 * about 2 requests a second. A company site is background material for a study kit, not a
 * dataset — and the batch harness gives five whole cases fifteen minutes.
 *
 * A page that cannot be retrieved is skipped and reported. One 404 never fails a crawl, and a
 * crawl that finds nothing never fails a run: it produces an honest brief that says so.
 */

export const DEFAULT_MAX_PAGES = 8;
export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_BYTES = 500 * 1024;
export const DEFAULT_REQUESTS_PER_SECOND = 2;
export const USER_AGENT = "TraoInterviewKitBot";

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  depth: number;
  score: number;
}

export interface SkippedUrl {
  url: string;
  reason: "robots" | "http_error" | "too_large" | "wrong_content_type" | "fetch_failed" | "budget";
  detail?: string;
}

/**
 * Why a discovered link never reached the ranker.
 *
 * Without these, `links_found=306 links_scored=88` and `links_found=1 links_scored=0` look like
 * the same kind of fact, and a client-rendered site is indistinguishable from a broken ranker.
 */
export interface UnscoredReasons {
  /** Pointed at another domain. */
  external: number;
  /** The page we were already on. */
  self: number;
  /** Already queued or already visited. */
  duplicate: number;
}

export interface CrawlResult {
  pages: CrawledPage[];
  skipped: SkippedUrl[];
  linksFound: number;
  linksScored: number;
  robotsBlocked: number;
  unscored: UnscoredReasons;
  /** URLs the site declared in its own sitemap. Zero is normal; it is how a SPA is readable. */
  sitemapUrls: number;
  sitemapsFetched: string[];
  /** Top five with their scores, for the trace. The evidence that ranking happened in code. */
  topLinks: { url: string; score: number; reasons: string[] }[];
}

export interface CrawlOptions {
  fetcher: HttpFetcher;
  clock: Clock;
  maxPages?: number;
  maxDepth?: number;
  timeoutMs?: number;
  maxBytes?: number;
  requestsPerSecond?: number;
  /** Fetched once per site. A missing or unparseable file means allow. */
  robotsTxt?: string | null;
  /** Sitemap discovery. On by default; off for tests that assert on anchors alone. */
  useSitemap?: boolean;
}

/**
 * @param homepage the already-fetched homepage, so `fetch_homepage` stays its own traced step
 *                 and its failure is distinguishable from a crawl that merely found nothing.
 */
export async function crawlSite(homepage: FetchResult, options: CrawlOptions): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const minIntervalMs = 1000 / (options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND);

  const robots: RobotsRules =
    options.robotsTxt != null && options.robotsTxt.length > 0
      ? parseRobots(options.robotsTxt, USER_AGENT)
      : ALLOW_ALL;

  const origin = new URL(homepage.finalUrl).origin;
  const visited = new Set<string>([normalise(homepage.finalUrl)]);
  const skipped: SkippedUrl[] = [];

  const pages: CrawledPage[] = [
    {
      url: homepage.finalUrl,
      title: pageTitle(homepage.body),
      text: cleanText(homepage.body),
      depth: 0,
      score: Number.POSITIVE_INFINITY,
    },
  ];

  // Links are resolved against the page's own final URL, never the origin.
  const queue: (ScoredLink & { depth: number })[] = [];
  let linksFound = 0;
  let robotsBlocked = 0;
  const unscored: UnscoredReasons = { external: 0, self: 0, duplicate: 0 };

  const consider = (candidates: { url: string; anchor: string }[], depth: number): void => {
    if (depth > maxDepth) return;

    const sameSite: { url: string; anchor: string }[] = [];
    for (const link of candidates) {
      if (!isSameSite(link.url, origin)) {
        unscored.external += 1;
        continue;
      }
      sameSite.push(link);
    }

    for (const scored of rankLinks(sameSite)) {
      const key = normalise(scored.url);
      if (visited.has(key)) {
        unscored.self += 1;
        continue;
      }
      if (queue.some((q) => normalise(q.url) === key)) {
        unscored.duplicate += 1;
        continue;
      }

      if (!isAllowed(robots, new URL(scored.url).pathname)) {
        robotsBlocked += 1;
        skipped.push({ url: scored.url, reason: "robots" });
        visited.add(key);
        continue;
      }

      queue.push({ ...scored, depth });
    }
  };

  const enqueue = (html: string, baseUrl: string, depth: number): void => {
    if (depth > maxDepth) return;
    const links = extractLinks(html, baseUrl);
    linksFound += links.length;
    consider(links, depth);
  };

  enqueue(homepage.body, homepage.finalUrl, 1);

  // The site's own declaration of what it contains, fed through the same ranker as the anchors.
  // On a client-rendered page this is the only list there is; on a normal site it adds the pages
  // the homepage happens not to link to. Either way we still do not guess a path — the site
  // names its URLs and the scoring function chooses among them.
  let sitemap = { urls: [] as string[], fetched: [] as string[] };
  if (options.useSitemap !== false) {
    sitemap = await discoverFromSitemaps({
      fetcher: options.fetcher,
      baseUrl: homepage.finalUrl,
      robotsTxt: options.robotsTxt ?? null,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });

    linksFound += sitemap.urls.length;
    // No anchor text to score on, so the URL tokens carry it — which is what the ranker already
    // weighs when an anchor is empty.
    consider(sitemap.urls.map((url) => ({ url, anchor: "" })), 1);
  }
  const topLinks = [...queue]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((link) => ({ url: link.url, score: link.score, reasons: link.reasons }));
  const linksScored = queue.length;

  let lastRequestAt = options.clock.now();

  while (pages.length < maxPages && queue.length > 0) {
    // Best-first: re-sorting each round because deeper pages join the queue as we go.
    queue.sort((a, b) => b.score - a.score || a.depth - b.depth || a.url.localeCompare(b.url));
    const next = queue.shift() as ScoredLink & { depth: number };
    visited.add(normalise(next.url));

    // Polite throttle. Uses the injected clock, so tests do not wait.
    const sinceLast = options.clock.now() - lastRequestAt;
    if (sinceLast < minIntervalMs) await options.clock.sleep(minIntervalMs - sinceLast);
    lastRequestAt = options.clock.now();

    let result: FetchResult;
    try {
      result = await options.fetcher.fetch(next.url, {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      });
    } catch (error) {
      // One bad page never aborts a crawl.
      skipped.push({ url: next.url, reason: reasonFor(error), detail: message(error) });
      continue;
    }

    if (result.status >= 400) {
      skipped.push({ url: next.url, reason: "http_error", detail: String(result.status) });
      continue;
    }
    if (!result.contentType.includes("html")) {
      skipped.push({ url: next.url, reason: "wrong_content_type", detail: result.contentType });
      continue;
    }

    pages.push({
      url: result.finalUrl,
      title: pageTitle(result.body),
      text: cleanText(result.body),
      depth: next.depth,
      score: next.score,
    });

    enqueue(result.body, result.finalUrl, next.depth + 1);
  }

  for (const remaining of queue) skipped.push({ url: remaining.url, reason: "budget" });

  return {
    pages,
    skipped,
    linksFound,
    linksScored,
    robotsBlocked,
    unscored,
    sitemapUrls: sitemap.urls.length,
    sitemapsFetched: sitemap.fetched,
    topLinks,
  };
}

/** Trailing-slash and index variants are the same page; fetching both wastes the budget. */
function normalise(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/index\.html?$/i, "/").replace(/(.)\/$/, "$1");
  return parsed.toString();
}

function reasonFor(error: unknown): SkippedUrl["reason"] {
  const text = message(error).toLowerCase();
  if (text.includes("too large") || text.includes("exceeds")) return "too_large";
  if (text.includes("content type")) return "wrong_content_type";
  return "fetch_failed";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
