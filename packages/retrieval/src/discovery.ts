import * as cheerio from "cheerio";
import { normaliseUrl } from "./url";

/**
 * Finding candidate links, from every source a page offers.
 *
 * Anchors alone are not enough, and a live run proved it twice over: galaxy.ai's homepage says
 * "Careers" in its rendered text, but the served HTML has five anchors, four of them to other
 * domains. The crawler discarded those four before scoring anything and concluded the site had
 * no careers page. It did — behind a link the crawler threw away.
 *
 * So discovery is deliberately greedy. Everything a page declares about its own structure gets
 * collected here — anchors, sitemaps, the route table a framework serialises into the document,
 * the organisation's own JSON-LD — and scoring decides what is worth fetching. Filtering before
 * scoring is what lost the page.
 */

export type CandidateSource = "anchor" | "sitemap" | "framework-state" | "json-ld";

/** Where on the page an anchor sat. Navigation and footers are where sites put "Careers". */
export type LinkPosition = "nav" | "footer" | "main" | "unknown";

export interface Candidate {
  url: string;
  anchor: string;
  position: LinkPosition;
  source: CandidateSource;
}

const NON_HTTP = /^(mailto:|tel:|javascript:|data:|blob:|#)/i;

function resolve(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "" || NON_HTTP.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Anchors, with the part of the page they came from. */
export function anchorCandidates(html: string, baseUrl: string): Candidate[] {
  const $ = cheerio.load(html);
  const found: Candidate[] = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    const url = resolve(href, baseUrl);
    if (url === null) return;

    const node = $(element);
    const position: LinkPosition =
      node.closest("nav, header, [role=navigation]").length > 0
        ? "nav"
        : node.closest("footer, [role=contentinfo]").length > 0
          ? "footer"
          : node.closest("main, article, [role=main]").length > 0
            ? "main"
            : "unknown";

    found.push({ url, anchor: node.text().replace(/\s+/g, " ").trim(), position, source: "anchor" });
  });

  return found;
}

/**
 * Routes a client-side framework serialised into the document.
 *
 * Next.js writes `__NEXT_DATA__`, Nuxt writes `__NUXT__`, and a great many apps write
 * `window.__INITIAL_STATE__`. None of them are anchors, so a crawler that only reads `<a>` sees
 * an empty page — which is exactly what happened. These blobs contain the route table, and a
 * route is a link whether or not anything renders it server-side.
 *
 * Extracted by regex rather than by parsing the JSON. The shape differs per framework and per
 * version, the only thing wanted is anything that looks like a path, and a parser that has to
 * understand five schemas is a parser that breaks on the sixth.
 */
const STATE_BLOCK =
  /<script[^>]*(?:id=["']__NEXT_DATA__["']|>\s*window\.__(?:NUXT|INITIAL_STATE|APOLLO_STATE|remixContext)__)[^>]*>([\s\S]*?)<\/script>/gi;

/** A quoted absolute path, or an absolute URL, inside a serialised blob. */
const ROUTE_IN_STATE = /"((?:https?:\/\/[^"\s]+)|(?:\/[a-z0-9][a-z0-9\-_/]*))"/gi;

/** Asset paths and API routes are not pages a candidate would read. */
const NOT_A_PAGE =
  /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|map|json|xml|txt|pdf|mp4|webm)(?:$|\?)|^\/(?:_next|_nuxt|api|static|assets|cdn-cgi|__)/i;

export function frameworkStateCandidates(html: string, baseUrl: string): Candidate[] {
  const found = new Map<string, Candidate>();

  for (const block of html.matchAll(STATE_BLOCK)) {
    const body = block[1] ?? "";
    for (const match of body.matchAll(ROUTE_IN_STATE)) {
      const raw = match[1];
      if (raw === undefined || NOT_A_PAGE.test(raw)) continue;

      const url = resolve(raw, baseUrl);
      if (url === null) continue;

      const key = normaliseUrl(url);
      if (found.has(key)) continue;
      // No anchor text exists for a route, so the URL path carries the whole signal.
      found.set(key, { url, anchor: "", position: "unknown", source: "framework-state" });
    }
  }

  return [...found.values()];
}

/**
 * `url` and `sameAs` from a JSON-LD Organization block.
 *
 * A company that publishes structured data usually points at its own canonical site and its
 * profiles. `sameAs` occasionally carries the careers host, which is the one case that matters
 * here; the rest is cheap to collect and cheap to score to zero.
 */
export function jsonLdCandidates(html: string, baseUrl: string): Candidate[] {
  const $ = cheerio.load(html);
  const found = new Map<string, Candidate>();

  $('script[type="application/ld+json"]').each((_, element) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse($(element).text()) as unknown;
    } catch {
      return; // Malformed structured data is the site's problem.
    }

    for (const node of flatten(parsed)) {
      if (typeof node !== "object" || node === null) continue;
      const record = node as Record<string, unknown>;

      const type = String(record["@type"] ?? "");
      if (!/organization|corporation|localbusiness/i.test(type)) continue;

      for (const value of [record["url"], ...(Array.isArray(record["sameAs"]) ? record["sameAs"] : [record["sameAs"]])]) {
        if (typeof value !== "string") continue;
        const url = resolve(value, baseUrl);
        if (url === null) continue;
        const key = normaliseUrl(url);
        if (!found.has(key)) found.set(key, { url, anchor: "", position: "unknown", source: "json-ld" });
      }
    }
  });

  return [...found.values()];
}

function flatten(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const graph = record["@graph"];
    return [value, ...(graph !== undefined ? flatten(graph) : [])];
  }
  return [value];
}

/**
 * Everything the page and the site declare, merged and deduplicated.
 *
 * A URL found in several places keeps the richest description of itself: an anchor with text
 * beats a bare route, and a nav position beats an unknown one. That matters because the anchor
 * text is usually the strongest signal a link has.
 */
export function mergeCandidates(...groups: readonly Candidate[][]): Candidate[] {
  const merged = new Map<string, Candidate>();

  for (const group of groups) {
    for (const candidate of group) {
      const key = normaliseUrl(candidate.url);
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, candidate);
        continue;
      }

      merged.set(key, {
        url: existing.url,
        anchor: existing.anchor.length >= candidate.anchor.length ? existing.anchor : candidate.anchor,
        position: existing.position !== "unknown" ? existing.position : candidate.position,
        source: existing.source,
      });
    }
  }

  return [...merged.values()];
}

/** Every in-page source at once. Sitemaps are fetched separately, being requests rather than reads. */
export function candidatesFromHtml(html: string, baseUrl: string): Candidate[] {
  return mergeCandidates(anchorCandidates(html, baseUrl), frameworkStateCandidates(html, baseUrl), jsonLdCandidates(html, baseUrl));
}
