import { describe, expect, it } from "vitest";
import { nextRewriteKey, rewriteKeeps, rewritePrompt, rewritingLabel } from "../src/lib/rewrite";

/**
 * The prompt a Regenerate press puts in the composer.
 *
 * It is the default, which makes it the sentence most rewrites are actually sent with — and the
 * sentence the composer compares against to decide whether anything the user typed counts as an
 * instruction. Both of those break quietly if the wording drifts, so it is pinned here.
 */
describe("rewritePrompt", () => {
  it("names the section, not 'the kit' — a rewrite replaces one part of it", () => {
    expect(rewritePrompt("company_brief")).toBe("Rewrite the company brief.");
    expect(rewritePrompt("schedule")).toBe("Rebuild the study schedule.");
    expect(rewritePrompt("questions", "technical")).toBe("Rewrite the technical questions.");
    expect(rewritePrompt("questions", "system-design")).toBe("Rewrite the system-design questions.");
  });

  it("stays sensible with no category, rather than saying 'undefined'", () => {
    expect(rewritePrompt("questions")).toBe("Rewrite the questions.");
  });
});

describe("rewriteKeeps", () => {
  it("says what survives, for every section", () => {
    expect(rewriteKeeps("questions")).toMatch(/pinned/i);
    expect(rewriteKeeps("schedule")).toMatch(/edited/i);
    expect(rewriteKeeps("company_brief")).toMatch(/nothing is fetched again/i);
  });

  it("admits that the schedule cannot act on an instruction", () => {
    // The composer takes free text for every section. For this one the text is recorded and not
    // acted on, because allocation is arithmetic in code — and the hint has to say so, or the
    // interface is promising something the pipeline deliberately does not do.
    expect(rewriteKeeps("schedule")).toMatch(/changes nothing/i);
  });
});

describe("rewritingLabel", () => {
  it("does not claim to be building a kit, because a rewrite is not", () => {
    expect(rewritingLabel("company_brief")).toBe("Rewriting the brief");
    expect(rewritingLabel("schedule")).toBe("Rebuilding the schedule");
    expect(rewritingLabel("questions:behavioural")).toBe("Rewriting the behavioural questions");
  });
});

describe("nextRewriteKey", () => {
  it("is new every time, so pressing the same button twice re-arms the composer", () => {
    expect(nextRewriteKey()).not.toBe(nextRewriteKey());
  });
});
