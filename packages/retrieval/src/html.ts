import * as cheerio from "cheerio";

/**
 * HTML to text, and HTML to links.
 *
 * `fetch` plus Cheerio, no headless browser. A company's careers page is server-rendered often
 * enough that the extra 300MB and the cold-start cost of a browser would buy very little, and
 * the brief's budget is one day.
 */

export interface ExtractedLink {
  /** Already absolute, resolved against the page's own final URL. */
  url: string;
  anchor: string;
}

const NON_CONTENT = "script, style, noscript, svg, iframe, template";

export function cleanText(html: string): string {
  const $ = cheerio.load(html);
  $(NON_CONTENT).remove();

  return $("body")
    .text()
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function pageTitle(html: string): string {
  return cheerio.load(html)("title").first().text().trim();
}

/**
 * Every link on the page, absolute.
 *
 * Resolved against `baseUrl`, which must be the page's **final** URL after redirects — not the
 * site root and not the URL we asked for. A site served from `http://localhost:8099/acme/` with
 * relative links is exactly the Appendix B shape, and resolving those against the origin would
 * turn `careers/` into `/careers/` and 404 on every one.
 */
export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href.trim())) return;

    let absolute: URL;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      return;
    }
    absolute.hash = "";

    const url = absolute.toString();
    if (seen.has(url)) return;
    seen.add(url);

    links.push({ url, anchor: $(element).text().replace(/\s+/g, " ").trim() });
  });

  return links;
}

/** Same site, so a crawl cannot wander onto someone else's domain. */
export function isSameSite(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
