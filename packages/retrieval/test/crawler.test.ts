import { describe, expect, it } from "vitest";
import type { FetchResult } from "@trao/contracts";
import { crawlSite } from "../src/crawler";
import { FakeFetcher, fixtureMounts } from "../src/fake-fetcher";
import { extractLinks } from "../src/html";
import { rankLinks, scoreLink } from "../src/ranking";
import { isAllowed, parseRobots } from "../src/robots";
import { FIXTURE_ROOT, TestClock } from "./helpers";

function fetcher(overrides?: FakeFetcher["options"]["overrides"]): FakeFetcher {
  return new FakeFetcher({ root: FIXTURE_ROOT, mounts: fixtureMounts(), ...(overrides ? { overrides } : {}) });
}

async function homepageOf(url: string, f: FakeFetcher): Promise<FetchResult> {
  return f.fetch(url);
}

describe("link ranking", () => {
  it("puts /handbook/hiring above /blog/post-42", () => {
    const hiring = scoreLink({ url: "https://meridian.test/handbook/hiring", anchor: "How we hire" });
    const blog = scoreLink({ url: "https://meridian.test/blog/post-42", anchor: "Why we rewrote our ingest pipeline" });

    expect(hiring.score).toBeGreaterThan(blog.score);
  });

  it("finds hiring material at a path no fixed list would guess", () => {
    // The brief says a fixed list of paths is not sufficient. /company/join-us has no "careers"
    // and no "jobs" in it; the anchor text is what carries the signal.
    const ranked = rankLinks([
      { url: "https://northwind.test/product", anchor: "Product" },
      { url: "https://northwind.test/docs/api", anchor: "API documentation" },
      { url: "https://northwind.test/company/join-us", anchor: "Life at Northwind — how we interview" },
      { url: "https://northwind.test/blog/2023/annual-review", anchor: "2023 in review" },
    ]);

    expect(ranked[0]?.url).toBe("https://northwind.test/company/join-us");
  });

  it("pushes legal and privacy pages to the bottom", () => {
    const ranked = rankLinks([
      { url: "https://meridian.test/legal/privacy", anchor: "Privacy policy" },
      { url: "https://meridian.test/about", anchor: "About us" },
    ]);

    expect(ranked[0]?.url).toBe("https://meridian.test/about");
  });

  it("explains itself, which is why this is not a model call", () => {
    const scored = scoreLink({ url: "https://meridian.test/handbook/hiring", anchor: "How we hire" });
    expect(scored.reasons.join(" ")).toContain("hiring");
  });

  it("is deterministic", () => {
    const links = [
      { url: "https://a.test/careers", anchor: "Careers" },
      { url: "https://a.test/jobs", anchor: "Jobs" },
    ];
    expect(rankLinks(links)).toEqual(rankLinks(links));
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

    expect(result.topLinks.length).toBeGreaterThan(0);
    expect(result.topLinks.length).toBeLessThanOrEqual(5);
    expect(result.topLinks[0]).toHaveProperty("reasons");
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
