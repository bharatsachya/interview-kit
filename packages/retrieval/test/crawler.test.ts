import { describe, expect, it } from "vitest";
import type { FetchResult } from "@trao/contracts";
import { crawlSite } from "../src/crawler";
import { FakeFetcher, fixtureMounts } from "../src/fake-fetcher";
import { extractLinks } from "../src/html";
import { anchorCandidates, frameworkStateCandidates, jsonLdCandidates, mergeCandidates } from "../src/discovery";
import { normaliseUrl } from "../src/url";
import { rankLinks, scoreLink } from "../src/ranking";
import { discoverFromSitemaps, parseSitemap, sitemapUrlsFromRobots } from "../src/sitemap";
import { isAllowed, parseRobots } from "../src/robots";
import { FIXTURE_ROOT, TestClock } from "./helpers";

function fetcher(overrides?: FakeFetcher["options"]["overrides"]): FakeFetcher {
  return new FakeFetcher({ root: FIXTURE_ROOT, mounts: fixtureMounts(), ...(overrides ? { overrides } : {}) });
}

/** A bare candidate, for scoring tests that do not care where the link was found. */
function link(url: string, anchor: string) {
  return { url, anchor, position: "unknown" as const, source: "anchor" as const };
}

async function homepageOf(url: string, f: FakeFetcher): Promise<FetchResult> {
  return f.fetch(url);
}

describe("link ranking", () => {
  it("puts /handbook/hiring above /blog/post-42", () => {
    const hiring = scoreLink(link("https://meridian.test/handbook/hiring", "How we hire"), "hiring");
    const blog = scoreLink(link("https://meridian.test/blog/post-42", "Why we rewrote our ingest pipeline"), "hiring");

    expect(hiring.score).toBeGreaterThan(blog.score);
  });

  it("finds hiring material at a path no fixed list would guess", () => {
    // The brief says a fixed list of paths is not sufficient. /company/join-us has no "careers"
    // and no "jobs" in it; the anchor text is what carries the signal.
    const ranked = rankLinks(
      [
        link("https://northwind.test/product", "Product"),
        link("https://northwind.test/docs/api", "API documentation"),
        link("https://northwind.test/company/join-us", "Life at Northwind — how we interview"),
        link("https://northwind.test/blog/2023/annual-review", "2023 in review"),
      ],
      "hiring",
    );

    expect(ranked[0]?.url).toBe("https://northwind.test/company/join-us");
  });

  it("pushes legal and privacy pages to the bottom", () => {
    const ranked = rankLinks(
      [link("https://meridian.test/legal/privacy", "Privacy policy"), link("https://meridian.test/about", "About us")],
      "about",
    );

    expect(ranked[0]?.url).toBe("https://meridian.test/about");
  });

  it("explains itself, which is why this is not a model call", () => {
    const scored = scoreLink(link("https://meridian.test/handbook/hiring", "How we hire"), "hiring");
    expect(scored.reasons.join(" ")).toContain("hiring");
  });

  it("is deterministic", () => {
    const links = [link("https://a.test/careers", "Careers"), link("https://a.test/jobs", "Jobs")];
    expect(rankLinks(links, "hiring")).toEqual(rankLinks(links, "hiring"));
  });
});

describe("relative links", () => {
  it("resolve against a non-root base path, the Appendix B shape", async () => {
    const f = fetcher();
    const homepage = await homepageOf("http://localhost:8099/acme/", f);
    const links = extractLinks(homepage.body, homepage.finalUrl).map((l) => l.url);

    // Resolving against the origin instead of the page would give /careers/ and 404 everything.
    expect(links).toContain("http://localhost:8099/acme/careers/");
    expect(links).toContain("http://localhost:8099/acme/about.html");
    expect(links).not.toContain("http://localhost:8099/careers/");
  });

  it("resolve upwards correctly from a nested page", async () => {
    const f = fetcher();
    const page = await f.fetch("http://localhost:8099/acme/careers/");
    const links = extractLinks(page.body, page.finalUrl).map((l) => l.url);

    expect(links).toContain("http://localhost:8099/acme/about.html");
  });

  it("skips mailto, tel and fragment links", () => {
    const html = '<a href="mailto:a@b.test">Mail</a><a href="tel:123">Call</a><a href="#top">Top</a><a href="/x">X</a>';
    expect(extractLinks(html, "https://a.test/").map((l) => l.url)).toEqual(["https://a.test/x"]);
  });
});

describe("crawlSite", () => {
  it("follows a deep link the ranking found and reads the hiring page", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
    });

    const hiring = result.pages.find((page) => page.url.includes("/handbook/hiring"));
    expect(hiring, "the handbook hiring page should have been crawled").toBeDefined();
    expect(hiring?.text).toContain("Take-home exercise");
    expect(hiring?.text).toContain("System design interview");
  });

  it("strips script and style content from the text", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
    });

    const hiring = result.pages.find((page) => page.url.includes("/handbook/hiring"));
    expect(hiring?.text).not.toContain("window.analytics");
    expect(hiring?.text).not.toContain("font-family");
  });

  it("stops at the page budget", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      maxPages: 3,
    });

    expect(result.pages).toHaveLength(3);
    expect(result.skipped.some((s) => s.reason === "budget")).toBe(true);
  });

  it("stops at depth 2", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      maxDepth: 2,
      maxPages: 20,
    });

    for (const page of result.pages) expect(page.depth).toBeLessThanOrEqual(2);
  });

  it("honours a robots.txt disallow and records the skip", async () => {
    const f = fetcher();
    const robotsTxt = (await f.fetch("https://meridian.test/robots.txt")).body;

    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      robotsTxt,
      maxPages: 20,
    });

    expect(result.robotsBlocked).toBeGreaterThan(0);
    expect(result.skipped.some((s) => s.reason === "robots" && s.url.includes("/private/"))).toBe(true);
    expect(result.pages.every((page) => !page.url.includes("/private/"))).toBe(true);
    expect(result.pages.every((page) => !page.url.includes("/legal/"))).toBe(true);
  });

  it("crawls everything when there is no robots.txt", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      robotsTxt: null,
      maxPages: 20,
    });

    expect(result.pages.length).toBeGreaterThan(1);
  });

  it("does not abort the crawl when one page 404s", async () => {
    const f = fetcher();
    // /pricing and /private/internal and several others do not exist as fixtures.
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      maxPages: 20,
    });

    expect(result.skipped.some((s) => s.reason === "http_error")).toBe(true);
    expect(result.pages.length).toBeGreaterThan(1);
  });

  it("rejects an oversized page rather than silently truncating it", async () => {
    const f = fetcher({
      "https://meridian.test/handbook/hiring": { body: "x".repeat(2_000) },
    });

    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      maxBytes: 500,
      maxPages: 20,
    });

    const skip = result.skipped.find((s) => s.url.includes("/handbook/hiring"));
    expect(skip?.reason).toBe("too_large");
    expect(result.pages.some((p) => p.url.includes("/handbook/hiring"))).toBe(false);
  });

  it("skips a non-HTML response", async () => {
    const f = fetcher({
      "https://meridian.test/handbook/hiring": { body: "{}", contentType: "application/json" },
    });

    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      maxPages: 20,
    });

    expect(result.skipped.some((s) => s.reason === "wrong_content_type")).toBe(true);
  });

  it("never leaves the site", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      maxPages: 20,
    });

    for (const page of result.pages) expect(new URL(page.url).origin).toBe("https://meridian.test");
    expect(f.requested.every((url) => url.startsWith("https://meridian.test"))).toBe(true);
  });

  it("throttles to the configured request rate", async () => {
    const clock = new TestClock(0);
    const f = fetcher();
    await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock,
      maxPages: 4,
      requestsPerSecond: 2,
    });

    // Three fetches after the homepage, at 500ms apart.
    expect(clock.now()).toBeGreaterThanOrEqual(1_000);
  });

  it("does not fetch the same page twice through a trailing-slash variant", async () => {
    const f = fetcher();
    await crawlSite(await homepageOf("https://meridian.test/", f), { fetcher: f, clock: new TestClock(), maxPages: 20 });

    expect(new Set(f.requested).size).toBe(f.requested.length);
  });

  it("reports the top scored links for the trace", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
    });

    expect(result.topLinks.hiring.length).toBeGreaterThan(0);
    expect(result.topLinks.hiring.length).toBeLessThanOrEqual(5);
    expect(result.topLinks.hiring[0]).toHaveProperty("reasons");
    expect(result.topLinks.hiring[0]).toHaveProperty("outcome");
    expect(result.linksFound).toBeGreaterThan(0);
  });
});

describe("the fixture sites", () => {
  it("sparse: a homepage and nothing else, which is the honest-brief path", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://calder.test/", f), {
      fetcher: f,
      clock: new TestClock(),
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.text).toContain("Industrial control software");
    expect(result.linksFound).toBe(0);
  });

  it("broken: everything 404s", async () => {
    const f = fetcher();
    const homepage = await homepageOf("https://gone.test/", f);

    expect(homepage.status).toBe(404);
  });

  it("deep: reaches the hiring page through ranking, not path guessing", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://northwind.test/", f), {
      fetcher: f,
      clock: new TestClock(),
    });

    const hiring = result.pages.find((page) => page.url.includes("/company/join-us"));
    expect(hiring?.text).toContain("pair-programming");
  });

  it("acme: crawls a site served from a sub-path", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("http://localhost:8099/acme/", f), {
      fetcher: f,
      clock: new TestClock(),
    });

    expect(result.pages.map((p) => p.url)).toContain("http://localhost:8099/acme/careers/");
    expect(result.pages.find((p) => p.url.endsWith("/careers/"))?.text).toContain("code reading exercise");
  });
});

describe("robots parsing", () => {
  it("applies the wildcard group", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private/", "TraoInterviewKitBot");
    expect(isAllowed(rules, "/private/x")).toBe(false);
    expect(isAllowed(rules, "/public/x")).toBe(true);
  });

  it("prefers a group naming us over the wildcard", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: TraoInterviewKitBot\nDisallow: /admin/",
      "TraoInterviewKitBot",
    );

    expect(isAllowed(rules, "/careers")).toBe(true);
    expect(isAllowed(rules, "/admin/x")).toBe(false);
  });

  it("lets a longer Allow override a shorter Disallow", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /docs/\nAllow: /docs/careers/", "bot");
    expect(isAllowed(rules, "/docs/other")).toBe(false);
    expect(isAllowed(rules, "/docs/careers/x")).toBe(true);
  });

  it("treats an empty Disallow as allow-everything", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:", "bot"), "/anything")).toBe(true);
  });

  it("ignores comments", () => {
    const rules = parseRobots("# a comment\nUser-agent: *\nDisallow: /x/ # trailing", "bot");
    expect(isAllowed(rules, "/x/y")).toBe(false);
  });

  it("allows everything when the file is empty or unparseable", () => {
    expect(isAllowed(parseRobots("", "bot"), "/anything")).toBe(true);
    expect(isAllowed(parseRobots("total nonsense", "bot"), "/anything")).toBe(true);
  });
});

/**
 * Discovery on a client-rendered site.
 *
 * A live crawl of a real SPA reported links_found=1 links_scored=0 — the server sends a mount
 * point and a bundle, so the HTML we receive has no anchors to rank. The hiring page is
 * reachable only because the site declares it in its own sitemap.
 */
describe("sitemap discovery", () => {
  it("finds the hiring page on a site with no anchors at all", async () => {
    const f = fetcher();
    const homepage = await homepageOf("https://halcyon.test/", f);

    // Nothing to rank from the HTML itself.
    expect(extractLinks(homepage.body, homepage.finalUrl)).toEqual([]);

    const result = await crawlSite(homepage, {
      fetcher: f,
      clock: new TestClock(),
      robotsTxt: (await f.fetch("https://halcyon.test/robots.txt")).body,
    });

    const hiring = result.pages.find((page) => page.url.includes("/join/how-we-hire"));
    expect(hiring, "the sitemap-declared hiring page should have been crawled").toBeDefined();
    expect(hiring?.text).toContain("pairing session");
  });

  it("still chooses by ranking rather than by guessing a path", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://halcyon.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      robotsTxt: (await f.fetch("https://halcyon.test/robots.txt")).body,
    });

    // /join/how-we-hire outranks /pricing and /legal/privacy, both of which the sitemap also
    // declares. Nothing in the code knows the word "join".
    expect(result.topLinks.hiring[0]?.url).toBe("https://halcyon.test/join/how-we-hire");
    expect(result.sitemapUrls).toBeGreaterThan(0);
    expect(result.sitemapsFetched.length).toBeGreaterThan(0);
  });

  it("reads a Sitemap: line from robots.txt", () => {
    const found = sitemapUrlsFromRobots(
      "User-agent: *\nAllow: /\n\nSitemap: https://halcyon.test/sitemap-index.xml\n",
      "https://halcyon.test/",
    );
    expect(found).toEqual(["https://halcyon.test/sitemap-index.xml"]);
  });

  it("follows a sitemap index one level down", async () => {
    const f = new FakeFetcher({
      root: FIXTURE_ROOT,
      mounts: fixtureMounts(),
      overrides: {
        "https://halcyon.test/sitemap.xml": {
          contentType: "application/xml",
          body: '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://halcyon.test/pages.xml</loc></sitemap></sitemapindex>',
        },
        "https://halcyon.test/pages.xml": {
          contentType: "application/xml",
          body: '<?xml version="1.0"?><urlset><url><loc>https://halcyon.test/join/how-we-hire</loc></url></urlset>',
        },
      },
    });

    const discovery = await discoverFromSitemaps({ fetcher: f, baseUrl: "https://halcyon.test/" });
    expect(discovery.urls).toContain("https://halcyon.test/join/how-we-hire");
  });

  it("ignores a sitemap entry pointing at another domain", async () => {
    const f = new FakeFetcher({
      root: FIXTURE_ROOT,
      mounts: fixtureMounts(),
      overrides: {
        "https://halcyon.test/sitemap.xml": {
          contentType: "application/xml",
          body: '<?xml version="1.0"?><urlset><url><loc>https://elsewhere.test/careers</loc></url><url><loc>https://halcyon.test/product</loc></url></urlset>',
        },
      },
    });

    const discovery = await discoverFromSitemaps({ fetcher: f, baseUrl: "https://halcyon.test/" });
    expect(discovery.urls).toEqual(["https://halcyon.test/product"]);
  });

  it("treats a missing sitemap as normal, not as an error", async () => {
    const f = fetcher();
    const discovery = await discoverFromSitemaps({ fetcher: f, baseUrl: "https://calder.test/" });

    expect(discovery.urls).toEqual([]);
    expect(discovery.missing.length).toBeGreaterThan(0);
  });

  it("decodes escaped ampersands in a loc", () => {
    const { locations } = parseSitemap('<urlset><url><loc>https://a.test/x?a=1&amp;b=2</loc></url></urlset>');
    expect(locations).toEqual(["https://a.test/x?a=1&b=2"]);
  });
});


/**
 * Discovery reworked: every source merged, everything scored, only then filtered.
 *
 * From a live crawl of galaxy.ai — the homepage text said "Careers", the crawler found five
 * links, discarded four as external before scoring anything, and concluded there was no hiring
 * page. One of the four was the hiring page, on an applicant tracking system.
 */
describe("an external careers link", () => {
  it("is followed to the ATS and recorded as external", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://kestrel.test/", f), {
      fetcher: f,
      clock: new TestClock(),
    });

    const hiring = result.pages.find((page) => page.url.includes("greenhouse.io"));
    expect(hiring, "the careers page is on greenhouse and must still be found").toBeDefined();
    expect(hiring?.text).toContain("How we interview");
    expect(hiring?.external).toBe(true);
    expect(result.hiringPageExternal).toBe(true);
  });

  it("scores the ATS host as a signal rather than discarding it", () => {
    const ats = scoreLink(link("https://boards.greenhouse.io/kestrel", "Careers"), "hiring");
    const twitter = scoreLink(link("https://twitter.com/kestrel", "Twitter"), "hiring");

    expect(ats.score).toBeGreaterThan(twitter.score);
    expect(ats.reasons.join(" ")).toContain("host:ats");
  });

  it("does not wander onto an unrelated external link", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://kestrel.test/", f), {
      fetcher: f,
      clock: new TestClock(),
    });

    expect(result.pages.every((page) => !page.url.includes("twitter.com"))).toBe(true);
    expect(result.skipped.some((s) => s.reason === "external_not_followed")).toBe(true);
  });

  it("stays on the site when external following is off", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://kestrel.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      followExternalHiring: false,
    });

    expect(result.hiringPageExternal).toBe(false);
    expect(result.pages.every((page) => !page.external)).toBe(true);
  });
});

describe("a page whose routes are only in framework state", () => {
  it("finds the hiring page from __NEXT_DATA__", async () => {
    const f = fetcher();
    const homepage = await homepageOf("https://lumen.test/", f);

    // Not one anchor on the page.
    expect(anchorCandidates(homepage.body, homepage.finalUrl)).toEqual([]);

    const result = await crawlSite(homepage, { fetcher: f, clock: new TestClock() });
    const hiring = result.pages.find((page) => page.url.includes("/company/how-we-hire"));

    expect(hiring, "the route was declared in __NEXT_DATA__").toBeDefined();
    expect(hiring?.text).toContain("code reading exercise");
    expect(result.bySource["framework-state"]).toBeGreaterThan(0);
  });

  it("ignores asset and API paths in the state blob", () => {
    const candidates = frameworkStateCandidates(
      '<script id="__NEXT_DATA__">{"a":"/_next/static/chunk.js","b":"/api/session","c":"/careers","d":"/logo.svg"}</script>',
      "https://a.test/",
    );

    expect(candidates.map((c) => new URL(c.url).pathname)).toEqual(["/careers"]);
  });

  it("reads sameAs out of a JSON-LD Organization block", () => {
    const found = jsonLdCandidates(
      '<script type="application/ld+json">{"@type":"Organization","url":"https://a.test/","sameAs":["https://jobs.lever.co/a"]}</script>',
      "https://a.test/",
    );

    expect(found.map((c) => c.url)).toContain("https://jobs.lever.co/a");
  });
});

describe("URL normalisation before dedupe", () => {
  it("counts /careers, /careers/ and /careers?utm_source=nav as one candidate", () => {
    const merged = mergeCandidates([
      link("https://a.test/careers", "Careers"),
      link("https://a.test/careers/", ""),
      link("https://a.test/careers?utm_source=nav&utm_medium=header", ""),
    ]);

    expect(merged).toHaveLength(1);
    // The richest description survives the merge.
    expect(merged[0]?.anchor).toBe("Careers");
  });

  it.each([
    ["https://A.test/Careers/", "https://a.test/Careers"],
    ["https://www.a.test/careers", "https://a.test/careers"],
    ["https://a.test/careers#openings", "https://a.test/careers"],
    ["https://a.test/careers?b=2&a=1", "https://a.test/careers?a=1&b=2"],
    ["https://a.test:443/careers", "https://a.test/careers"],
    ["https://a.test/careers/index.html", "https://a.test/careers"],
  ])("normalises %s", (input, expected) => {
    expect(normaliseUrl(input)).toBe(expected);
  });

  it("keeps a parameter that selects the page", () => {
    expect(normaliseUrl("https://a.test/jobs?team=eng")).toContain("team=eng");
  });

  it("spends only one fetch on a page linked three ways", async () => {
    const f = new FakeFetcher({
      root: FIXTURE_ROOT,
      mounts: fixtureMounts(),
      overrides: {
        "https://dupe.test/": {
          body: `<nav><a href="/careers">Careers</a></nav>
                 <main><a href="/careers/">Open roles</a></main>
                 <footer><a href="/careers?utm_source=footer">Join us</a></footer>`,
        },
        "https://dupe.test/careers": { body: "<h1>Careers</h1><p>How we hire: two rounds.</p>" },
      },
    });

    const result = await crawlSite(await f.fetch("https://dupe.test/"), {
      fetcher: f,
      clock: new TestClock(),
      useSitemap: false,
    });

    expect(result.linksFound).toBe(1);
    expect(f.requested.filter((url) => url.includes("careers"))).toHaveLength(1);
  });
});

describe("the two scorers", () => {
  it("ranks /handbook/hiring above /blog/post-42 for hiring", () => {
    const hiring = scoreLink(link("https://meridian.test/handbook/hiring", "How we hire"), "hiring");
    const blog = scoreLink(link("https://meridian.test/blog/post-42", "Why we rewrote our ingest pipeline"), "hiring");

    expect(hiring.score).toBeGreaterThan(blog.score);
  });

  it("ranks an about page above a hiring page for about", () => {
    const about = scoreLink(link("https://a.test/about", "About us"), "about");
    const careers = scoreLink(link("https://a.test/careers", "Careers"), "about");

    expect(about.score).toBeGreaterThan(careers.score);
  });

  it("weights a nav link above the same link buried in a page", () => {
    const inNav = scoreLink({ ...link("https://a.test/careers", "Careers"), position: "nav" }, "hiring");
    const inBody = scoreLink({ ...link("https://a.test/careers", "Careers"), position: "main" }, "hiring");

    expect(inNav.score).toBeGreaterThan(inBody.score);
  });

  it("reports an outcome for every top link", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
    });

    for (const kind of ["hiring", "about"] as const) {
      for (const entry of result.topLinks[kind]) {
        expect(entry.outcome).toBeTruthy();
        expect(entry.reasons.length).toBeGreaterThan(0);
      }
    }
  });

  it("fetches from both lists rather than three of whichever scores higher", async () => {
    const f = fetcher();
    const result = await crawlSite(await homepageOf("https://meridian.test/", f), {
      fetcher: f,
      clock: new TestClock(),
      maxPages: 5,
    });

    const kinds = new Set(result.pages.map((page) => page.kind));
    expect(kinds.has("hiring")).toBe(true);
    expect(kinds.has("about")).toBe(true);
  });
});

describe("a host the fixture fetcher does not serve", () => {
  it("says so, rather than reporting a 404", async () => {
    // A `--fake-fetch` run against a real company URL told a browser "company site returned 404
    // for https://magica.com/", which reads as the site being down. It was the fetcher not
    // knowing the host. The two failures need different messages, because the fixes differ.
    const f = fetcher();

    await expect(f.fetch("https://magica.com/")).rejects.toThrow(/no fixture mounted for magica\.com/);
    await expect(f.fetch("https://magica.com/")).rejects.toMatchObject({
      details: { fixture_miss: true, host: "magica.com" },
    });
  });

  it("names what it does serve, so the fix is obvious", async () => {
    const f = fetcher();
    await expect(f.fetch("https://unknown.test/")).rejects.toThrow(/meridian\.test/);
    await expect(f.fetch("https://unknown.test/")).rejects.toThrow(/dev:real/);
  });

  it("still returns a real 404 for a missing page on a site it does serve", async () => {
    const f = fetcher();
    const result = await f.fetch("https://meridian.test/no-such-page");

    expect(result.status).toBe(404);
    expect(result.bytes).toBe(Buffer.byteLength(result.body));
  });
});
