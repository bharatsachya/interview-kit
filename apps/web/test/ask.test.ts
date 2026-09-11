import { describe, expect, it } from "vitest";
import { askPlainText, askSize, askTitle } from "../src/lib/ask";

describe("describing the posting a run was started from", () => {
  it("titles it by its first real line", () => {
    expect(askTitle("Senior Backend Engineer\nAcme — Berlin")).toBe("Senior Backend Engineer");
    expect(askTitle("\n\n  Data Scientist  \nmore")).toBe("Data Scientist");
  });

  it("trims a long first line at a word boundary rather than mid-token", () => {
    const out = askTitle("A".repeat(20) + " " + "B".repeat(80));
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("BB…");
  });

  it("falls back to a name when the posting has no first line to use", () => {
    expect(askTitle("   \n  \n ")).toBe("Job description");
  });

  it("counts words, so the card says what opening it costs", () => {
    expect(askSize("one two three")).toBe("3 words");
    expect(askSize("solo")).toBe("1 word");
  });

  it("copies the posting whole, with the settings that went with it", () => {
    const text = askPlainText({ jd: "Full posting here", url: "https://acme.com", days: 1 });
    expect(text).toContain("Full posting here");
    expect(text).toContain("1 day until the interview");
  });
});
