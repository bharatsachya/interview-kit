/**
 * @trao/retrieval — fetching a company site and deciding which of its pages are worth reading.
 *
 * No LLM anywhere in this package. Link ranking is a scoring function precisely so the trace can
 * show why each page was chosen.
 */

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PAGES,
  DEFAULT_REQUESTS_PER_SECOND,
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
  crawlSite,
  type CrawlOptions,
  type CrawlResult,
  type CrawledPage,
  type SkippedUrl,
} from "./crawler";
export { FakeFetcher, fixtureMounts, type FakeFetcherOptions } from "./fake-fetcher";
export { cleanText, extractLinks, isSameSite, pageTitle, type ExtractedLink } from "./html";
export { LiveHttpFetcher, type HttpFetcherOptions } from "./http-fetcher";
export { rankLinks, scoreLink, type ScoredLink } from "./ranking";
export { ALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from "./robots";
export { assertFetchable, isFetchable, isPrivateAddress, type UrlGuardOptions } from "./url-guard";
