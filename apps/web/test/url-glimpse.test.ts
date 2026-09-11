import { describe, expect, it } from "vitest";
import { glimpseUrl } from "../src/lib/url-glimpse";

describe("shortening a URL to the part worth reading", () => {
  it("drops the scheme and www, which identify nothing", () => {
    expect(glimpseUrl("https://www.stripe.com")).toBe("stripe.com");
    expect(glimpseUrl("http://acme.io/")).toBe("acme.io");
  });

  it("keeps a short URL whole", () => {
    expect(glimpseUrl("https://tavily.com/about")).toBe("tavily.com/about");
  });

  it("keeps the host intact and elides the middle of the path", () => {
    const out = glimpseUrl("https://www.digitalxnode.com/jobs/data-scientist-ai-ml/");
    expect(out.startsWith("digitalxnode.com/")).toBe(true);
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(34);
    // Both ends of the path survive: the section, and the page.
    expect(out.endsWith("ml")).toBe(true);
  });

  it("keeps the registrable domain when the host alone is too long", () => {
    const out = glimpseUrl("https://a-very-long-subdomain-indeed.example-company-name.com", 24);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out.endsWith("company-name.com")).toBe(true);
  });

  it("has nothing to say about an empty value", () => {
    expect(glimpseUrl("")).toBe("");
    expect(glimpseUrl("   ")).toBe("");
  });
});
