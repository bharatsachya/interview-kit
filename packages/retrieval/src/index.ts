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
  DEFAULT_PER_SCORER,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_EXTERNAL_HIRING_THRESHOLD,
  USER_AGENT,
  crawlSite,
  type CrawlOptions,
  type CrawlResult,
  type CrawledPage,
  type LinkOutcome,
  type RankedReport,
  type SkipReason,
  type SkippedUrl,
} from "./crawler";
export { FakeFetcher, fixtureMounts, type FakeFetcherOptions } from "./fake-fetcher";
export { cleanText, extractLinks, isSameSite, pageTitle, type ExtractedLink } from "./html";
export { LiveHttpFetcher, type HttpFetcherOptions } from "./http-fetcher";
export { ATS_HOSTS, rankLinks, scoreLink, type ScoredLink, type ScoreOptions, type ScorerKind } from "./ranking";
export {
  anchorCandidates,
  candidatesFromHtml,
  frameworkStateCandidates,
  jsonLdCandidates,
  mergeCandidates,
  type Candidate,
  type CandidateSource,
  type LinkPosition,
} from "./discovery";
export { hostOf, isSameRegistrableSite, normaliseUrl } from "./url";
export {
  MAX_SITEMAP_FETCHES,
  MAX_SITEMAP_URLS,
  discoverFromSitemaps,
  parseSitemap,
  sitemapUrlsFromRobots,
  type DiscoverOptions,
  type SitemapDiscovery,
} from "./sitemap";
export { ALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from "./robots";
export { assertFetchable, isFetchable, isPrivateAddress, type UrlGuardOptions } from "./url-guard";
