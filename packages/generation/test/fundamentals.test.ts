import { describe, expect, it } from "vitest";
import { fundamentalsFor } from "../src/fundamentals";

/**
 * The band the posting cannot ask for.
 *
 * DSA is screened for in a large share of engineering interviews and named in almost none of the
 * adverts, so a kit built strictly from the posting leaves a candidate unready for the round they
 * are most likely to sit. What these cases hold is the line that keeps it honest: these questions
 * assert nothing about the employer and close no coverage gap.
 */
describe("fundamentalsFor", () => {
  const backend = { roleTitle: "Senior Backend Engineer", requirements: ["PostgreSQL query tuning"] };

  it("covers the core structures every interview can reach for", () => {
    const prompts = fundamentalsFor(backend).map((q) => q.prompt.toLowerCase()).join(" ");
    expect(prompts).toContain("array");
    expect(prompts).toContain("hash map");
    expect(prompts).toMatch(/tree or a graph/);
    expect(prompts).toContain("complexity");
  });

  it("claims no requirement, which is the truth about it", () => {
    // The grounding rule is about claims concerning the employer. These make none — and an empty
    // `requirementIds` is what stops coverage counting them as closing a gap they never addressed.
    for (const question of fundamentalsFor(backend)) {
      expect(question.requirementIds).toEqual([]);
    }
  });

  it("says in the document where it came from", () => {
    for (const question of fundamentalsFor(backend)) {
      expect(question.origin).toBe("fundamentals");
      // `regenerateCategory` only takes back `generated`, so these survive a rewrite of the
      // technical bank — like a fallback, and for the same reason.
      expect(question.origin).not.toBe("generated");
    }
  });

  it("puts them in technical, because Appendix A's four categories are frozen", () => {
    for (const question of fundamentalsFor(backend)) {
      expect(question.category).toBe("technical");
    }
  });

  it("asks a non-engineering role nothing", () => {
    // A recruiter preparing for a content role does not need to be asked about hash maps, and a
    // kit that asked would be worse than one that did not.
    expect(fundamentalsFor({ roleTitle: "Content Marketing Manager", requirements: [] })).toEqual([]);
    expect(fundamentalsFor({ roleTitle: "Head of People", requirements: [] })).toEqual([]);
  });

  it("still recognises an engineering role from a title that hides it", () => {
    // "Member of Technical Staff" names no discipline; its requirements do.
    const opaque = { roleTitle: "Member of Technical Staff", requirements: ["Distributed systems in Go"] };
    expect(fundamentalsFor(opaque).length).toBeGreaterThan(0);
  });

  it("varies only the applied question, by what the role actually is", () => {
    const data = fundamentalsFor({ roleTitle: "Machine Learning Engineer", requirements: ["PyTorch"] });
    const front = fundamentalsFor({ roleTitle: "Frontend Engineer", requirements: ["React"] });

    expect(data.at(-1)?.prompt).toMatch(/stream|frequent/i);
    expect(front.at(-1)?.prompt).toMatch(/rows|render/i);
    // Complexity and the core structures do not differ by stack, so the other four do not either.
    expect(data.slice(0, -1).map((q) => q.prompt)).toEqual(front.slice(0, -1).map((q) => q.prompt));
  });

  it("is deterministic, so a fake run stays byte-identical", () => {
    expect(fundamentalsFor(backend)).toEqual(fundamentalsFor(backend));
  });

  it("orders them, easiest first", () => {
    const questions = fundamentalsFor(backend);
    expect(questions.map((q) => q.order)).toEqual(questions.map((_, index) => index));
    expect(questions[0]?.difficulty).toBeLessThanOrEqual(questions.at(-1)?.difficulty ?? 0);
  });
});
