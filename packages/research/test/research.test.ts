import { describe, expect, it, vi } from "vitest";
import type { SearchProvider } from "@trao/contracts";
import { discussionQuery, searchDiscussion } from "../src/discussion";
import { NullSearchProvider, TavilySearchProvider } from "../src/providers";

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
