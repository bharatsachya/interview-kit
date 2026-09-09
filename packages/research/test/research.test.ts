import { describe, expect, it, vi } from "vitest";
import type { SearchProvider, SearchResult } from "@trao/contracts";
import { discussionQuery, searchDiscussion } from "../src/discussion";
import { NullSearchProvider, TavilySearchProvider } from "../src/providers";
import { filterRelevant } from "../src/relevance";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("searchDiscussion", () => {
  it("returns empty and marks skipped when there is no API key", async () => {
    const result = await searchDiscussion(new NullSearchProvider(), { company: "Acme" });

    expect(result.results).toEqual([]);
    expect(result.skippedReason).toBe("no_key");
    expect(result.provider).toBe("none");
  });

  it("does not throw when the provider errors — this step is never fatal", async () => {
    const exploding: SearchProvider = {
      name: "tavily",
      search: async () => {
        throw new Error("upstream is down");
      },
    };

    const result = await searchDiscussion(exploding, { company: "Acme" });

    expect(result.results).toEqual([]);
    expect(result.skippedReason).toBe("provider_error");
  });

  it("returns results when the provider works", async () => {
    const provider: SearchProvider = {
      name: "tavily",
      search: async () => [{ title: "Interviewing at Acme", url: "https://forum.test/1", content: "Two rounds." }],
    };

    const result = await searchDiscussion(provider, { company: "Acme" });

    expect(result.results).toHaveLength(1);
    expect(result.skippedReason).toBeUndefined();
  });

  it("skips rather than searching for nothing when the company is unknown", async () => {
    const provider = { name: "tavily", search: vi.fn(async () => []) } satisfies SearchProvider;
    const result = await searchDiscussion(provider, { company: "   " });

    expect(result.skippedReason).toBe("no_company");
    expect(provider.search).not.toHaveBeenCalled();
  });

  it("builds the query in code, including the role when known", () => {
    expect(discussionQuery({ company: "Acme" })).toBe("Acme interview process engineering hiring");
    expect(discussionQuery({ company: "Acme", roleTitle: "Senior Backend Engineer" })).toBe(
      "Acme Senior Backend Engineer interview process engineering hiring",
    );
  });
});

describe("TavilySearchProvider", () => {
  it("maps a response into SearchResults", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          { title: "Acme interviews", url: "https://forum.test/1", content: "Two rounds.", score: 0.9 },
          { title: "No url here" },
        ],
      }),
    );

    const results = await new TavilySearchProvider({ apiKey: "k", fetchImpl }).search("Acme interview process");

    expect(results).toEqual([
      { title: "Acme interviews", url: "https://forum.test/1", content: "Two rounds.", score: 0.9 },
    ]);
  });

  it("sends the query and the key", async () => {
    const sent: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent.push(init ?? {});
      return jsonResponse({ results: [] });
    };

    await new TavilySearchProvider({ apiKey: "secret", fetchImpl }).search("q", { maxResults: 3 });

    const body = JSON.parse(sent[0]?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ api_key: "secret", query: "q", max_results: 3 });
  });

  it("throws on a non-OK response, which searchDiscussion turns into a skip", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const provider = new TavilySearchProvider({ apiKey: "k", fetchImpl });

    await expect(provider.search("q")).rejects.toThrow(/503/);
    await expect(searchDiscussion(provider, { company: "Acme" })).resolves.toMatchObject({
      skippedReason: "provider_error",
      results: [],
    });
  });

  it("tolerates a response with no results field", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(new TavilySearchProvider({ apiKey: "k", fetchImpl }).search("q")).resolves.toEqual([]);
  });
});

/**
 * Relevance filtering.
 *
 * A live search for "Magica" returned five results about Magic Software, Magic.dev and generic
 * interview advice. The brief writer noticed and said so in prose, but every one of those URLs
 * stayed in `company_brief.sources` — a factual claim about what the kit was built from.
 */
describe("filterRelevant", () => {
  const result = (url: string, title: string, content = ""): SearchResult => ({ url, title, content });

  it("drops a different company with a similar name", () => {
    const { kept, dropped } = filterRelevant(
      [
        result("https://magicsoftware.com/careers", "Careers at Magic Software", "Magic Software hiring process"),
        result("https://magic.dev/blog/interviews", "How Magic interviews engineers", "Magic is an AI startup"),
        result("https://galaxy.ai/about", "About Magica", "Magica is built by GalaxyAI"),
      ],
      { company: "Magica", companyUrl: "https://galaxy.ai" },
    );

    expect(kept.map((r) => r.url)).toEqual(["https://galaxy.ai/about"]);
    expect(dropped.map((d) => d.reason)).toEqual(["wrong_company", "wrong_company"]);
  });

  it("does not match a shorter name inside a longer one", () => {
    // "magic" must not match "Magica", nor "Magica" match "Magic".
    const { kept } = filterRelevant([result("https://magic.dev/x", "Magic raises a round", "About Magic")], {
      company: "Magica",
    });
    expect(kept).toEqual([]);
  });

  it("keeps a result on the company's own domain even without the name", () => {
    const { kept } = filterRelevant([result("https://galaxy.ai/careers", "Open roles", "Join the team")], {
      company: "Magica",
      companyUrl: "https://galaxy.ai",
    });
    expect(kept).toHaveLength(1);
  });

  it("drops generic career-advice sites", () => {
    const { kept, dropped } = filterRelevant(
      [result("https://www.indeed.com/advice/interviewing", "Magica interview tips", "Common questions to expect")],
      { company: "Magica", companyUrl: "https://galaxy.ai" },
    );

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("generic_advice");
  });

  it("tolerates a company suffix", () => {
    const { kept } = filterRelevant([result("https://news.test/x", "GalaxyAI ships Magica", "GalaxyAI Inc.")], {
      company: "GalaxyAI Inc.",
    });
    expect(kept).toHaveLength(1);
  });

  it("keeps everything when there is nothing to match on", () => {
    const results = [result("https://a.test/x", "Something")];
    expect(filterRelevant(results, { company: "" }).kept).toEqual(results);
  });
});

describe("the discussion query", () => {
  it("includes the company's domain, which is what disambiguates a colliding name", () => {
    const query = discussionQuery({ company: "Magica", companyUrl: "https://galaxy.ai", roleTitle: "Software Engineer" });

    expect(query).toContain("Magica");
    expect(query).toContain("galaxy.ai");
    expect(query).toContain("interview process");
  });

  it("omits the domain when no company URL is known", () => {
    expect(discussionQuery({ company: "Acme" })).toBe("Acme interview process engineering hiring");
  });
});

describe("searchDiscussion reports what it filtered", () => {
  it("keeps the relevant result and records the rest", async () => {
    const provider: SearchProvider = {
      name: "tavily",
      search: async () => [
        { title: "Magic Software careers", url: "https://magicsoftware.com/x", content: "Magic Software" },
        { title: "About Magica", url: "https://galaxy.ai/about", content: "Magica by GalaxyAI" },
      ],
    };

    const outcome = await searchDiscussion(provider, { company: "Magica", companyUrl: "https://galaxy.ai" });

    expect(outcome.results.map((r) => r.url)).toEqual(["https://galaxy.ai/about"]);
    expect(outcome.filtered).toHaveLength(1);
    expect(outcome.skippedReason).toBeUndefined();
  });
});
