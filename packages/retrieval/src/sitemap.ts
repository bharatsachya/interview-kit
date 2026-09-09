import type { FetchResult, HttpFetcher } from "@trao/contracts";

/**
 * Link discovery through sitemaps.
 *
 * A crawl of galaxy.ai found **one** link and scored none: the site is client-rendered, so the
 * HTML the fetcher receives contains almost no anchors. Ranking cannot choose a hiring page out
 * of a list that does not exist, and without this the trace shows `links_found=1` with no
 * indication of why — indistinguishable from a broken ranker.
 *
 * A sitemap is the site telling us its own URLs, in a machine-readable file it maintains for
 * exactly this purpose. Reading it is standard discovery, not a fixed list of paths: we still do
 * not know or guess where the hiring page is, we hand every URL the site declares to the same
 * scoring function and let it choose. `/careers` gets found on a SPA because the site said
 * `/careers` exists, not because we guessed the word.
 *
 * Both sources are checked — `/sitemap.xml` by convention, and any `Sitemap:` line in robots.txt,
 * which is where a site with a non-standard location declares it.
 */

/** Sitemaps can be enormous; a company site's hiring page is never at index 9,000. */
export const MAX_SITEMAP_URLS = 200;
/** A sitemap index points at more sitemaps. One level down is plenty for a company site. */
export const MAX_SITEMAP_FETCHES = 4;

export interface SitemapDiscovery {
  urls: string[];
  /** Which sitemap files were read, for the trace. */
  fetched: string[];
  /** Sitemaps we looked for and did not find. Not an error — most small sites have none. */
  missing: string[];
}

/** `Sitemap: https://example.test/sitemap-index.xml` lines from a robots.txt body. */
export function sitemapUrlsFromRobots(robotsTxt: string | null, baseUrl: string): string[] {
  if (robotsTxt === null) return [];

  const found: string[] = [];
  for (const line of robotsTxt.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (match?.[1] === undefined) continue;
    try {
      found.push(new URL(match[1], baseUrl).toString());
    } catch {
      // A malformed Sitemap: line is the site's problem, not a reason to stop.
    }
  }
  return found;
}

/**
 * Pull `<loc>` values out of a sitemap or sitemap index.
 *
 * Deliberately a regex rather than an XML parser. A sitemap is a flat list of `<loc>` elements,
 * the only thing we want is their text, and adding an XML dependency to read one tag would be a
 * poor trade — the same reasoning that keeps a headless browser out of this package.
 */
export function parseSitemap(xml: string): { locations: string[]; isIndex: boolean } {
  const locations: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)) {
    const value = match[1];
    if (value !== undefined) locations.push(decodeEntities(value.trim()));
  }
  return { locations, isIndex: /<sitemapindex[\s>]/i.test(xml) };
}

export interface DiscoverOptions {
  fetcher: HttpFetcher;
  /** The site's origin-rooted base, after redirects. */
  baseUrl: string;
  robotsTxt?: string | null;
  maxUrls?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function discoverFromSitemaps(options: DiscoverOptions): Promise<SitemapDiscovery> {
  const maxUrls = options.maxUrls ?? MAX_SITEMAP_URLS;
  const origin = new URL(options.baseUrl).origin;

  const queue = [
    ...sitemapUrlsFromRobots(options.robotsTxt ?? null, options.baseUrl),
    new URL("/sitemap.xml", options.baseUrl).toString(),
  ].filter((url, index, all) => all.indexOf(url) === index);

  const urls = new Set<string>();
  const fetched: string[] = [];
  const missing: string[] = [];
  let fetches = 0;

  while (queue.length > 0 && fetches < MAX_SITEMAP_FETCHES && urls.size < maxUrls) {
    const target = queue.shift() as string;
    // A sitemap on someone else's domain is not this site's declaration.
    if (new URL(target).origin !== origin) continue;

    fetches += 1;
    let result: FetchResult;
    try {
      result = await options.fetcher.fetch(target, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      });
    } catch {
      missing.push(target);
      continue;
    }

    if (result.status >= 400) {
      missing.push(target);
      continue;
    }

    fetched.push(target);
    const { locations, isIndex } = parseSitemap(result.body);

    for (const location of locations) {
      let absolute: URL;
      try {
        absolute = new URL(location, result.finalUrl);
      } catch {
        continue;
      }
      if (absolute.origin !== origin) continue;

      // An index lists sitemaps; a sitemap lists pages.
      if (isIndex) queue.push(absolute.toString());
      else if (urls.size < maxUrls) urls.add(absolute.toString());
    }
  }

  return { urls: [...urls], fetched, missing };
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}
