import { describe, expect, it } from "vitest";
import type { Span, SpanStatus } from "@trao/contracts";
import { spanConsequence, spanResult, spanTone, stepLabel, toStreamRows } from "../src/lib/spans";

/**
 * The conversation's one piece of real logic.
 *
 * The rule it has to hold is the product's, not the display's: honest degradation is a success.
 * A skipped search must never read the way a failure reads, because the run carried on and the
 * kit is fine. These tests exist so that survives somebody later "simplifying" the tone map.
 *
 * The second rule is that every number shown comes off the span. A step whose attributes are
 * missing must show no result rather than a plausible-looking invented one.
 */

let counter = 0;
function span(
  step: string,
  attrs: Record<string, unknown> = {},
  status: SpanStatus = "ok",
  extra: Partial<Span> = {},
): Span {
  counter += 1;
  return {
    id: `s${counter}`,
    parentId: null,
    step,
    startedAt: 0,
    endedAt: 1000,
    durationMs: 1000,
    status,
    attrs,
    ...extra,
  };
}

describe("spanTone", () => {
  it("reads a skipped step as information, not as an error", () => {
    expect(spanTone(span("search_discussion", { reason: "No search key." }, "skipped"))).toBe("info");
  });

  it("reserves trouble for a step that actually errored", () => {
    expect(spanTone(span("fetch_homepage", {}, "failed"))).toBe("trouble");
    expect(spanTone(span("generate_brief"))).toBe("done");
  });
});

describe("spanResult", () => {
  it("reports requirements as found and must-have", () => {
    expect(spanResult(span("extract_requirements", { requirements: 12, must_have: 7 }))).toBe(
      "12 found, 7 must-have",
    );
  });

  it("names the host it fetched", () => {
    expect(spanResult(span("fetch_homepage", { host: "gitlab.com" }))).toBe("gitlab.com");
  });

  it("names the hiring page it found, and says so when it found none", () => {
    expect(spanResult(span("crawl_site", { hiring_page: "/handbook/hiring" }))).toBe("found /handbook/hiring");
    expect(spanResult(span("crawl_site", { pages_fetched: 6 }))).toBe("6 pages, no hiring page");
  });

  it("renders a skip as informational text carrying its reason", () => {
    expect(spanResult(span("search_discussion", { reason: "No search key." }, "skipped"))).toBe(
      "skipped, no search key.",
    );
  });

  it("distinguishes the two coverage passes, and says when the gaps are closed", () => {
    expect(spanResult(span("coverage_check", { pass: 1, gaps: 2 }))).toBe("pass 1: 2 gaps");
    expect(spanResult(span("coverage_check", { pass: 1, gaps: 1 }))).toBe("pass 1: 1 gap");
    expect(spanResult(span("coverage_check", { pass: 2, gaps: 0 }))).toBe("pass 2: all must-haves covered");
  });

  it("names the requirements the gap-fill pass closed", () => {
    expect(spanResult(span("gap_fill", { covered: ["REQ-12"] }))).toBe("REQ-12 covered");
  });

  it("reports the schedule in days and minutes", () => {
    expect(spanResult(span("allocate_schedule", { days: 5, minutes: 330 }))).toBe("5 days, 330 minutes");
    expect(spanResult(span("allocate_schedule", { days: 1, minutes: 60 }))).toBe("1 day, 60 minutes");
  });

  it("shows nothing rather than inventing a number when the attribute is missing", () => {
    expect(spanResult(span("extract_requirements"))).toBeNull();
    expect(spanResult(span("allocate_schedule"))).toBeNull();
    expect(spanResult(span("generate_brief"))).toBeNull();
  });

  it("ignores an attribute of the wrong type instead of printing it", () => {
    expect(spanResult(span("extract_requirements", { requirements: "twelve" }))).toBeNull();
    expect(spanResult(span("gap_fill", { covered: "REQ-12" }))).toBeNull();
  });
});

describe("spanConsequence", () => {
  it("says what a failed fetch means for the kit, not what broke", () => {
    expect(spanConsequence(span("fetch_homepage", {}, "failed"))).toBe(
      "generating from the job description alone",
    );
  });

  it("reassures that an unrelated failure leaves the rest alone", () => {
    expect(spanConsequence(span("derive_flashcards", {}, "failed"))).toBe("the rest of the kit is unaffected");
  });

  it("carries a recorded degradation on a step that still succeeded", () => {
    expect(spanConsequence(span("generate_brief", { degraded: "written from the job description alone" }))).toBe(
      "written from the job description alone",
    );
  });
});

describe("stepLabel", () => {
  it("names each generation call by its category", () => {
    expect(stepLabel("generate_questions.technical", { category: "technical" })).toBe(
      "Generating technical questions",
    );
    expect(stepLabel("generate_questions.company-fit", { category: "company-fit" })).toBe(
      "Generating company-fit questions",
    );
  });

  it("works from a step name alone, for the row shown while a step is in flight", () => {
    expect(stepLabel("crawl_site")).toBe("Crawling for hiring page");
  });

  it("falls back to a readable form of a step it does not know", () => {
    expect(stepLabel("some_new_step")).toBe("some new step");
  });
});

describe("toStreamRows", () => {
  it("drops a parent in favour of its children — four calls say more than one step", () => {
    const parent = span("generate_questions");
    const children = ["technical", "behavioural"].map((category) => ({
      ...span(`generate_questions.${category}`, { category, count: 4 }),
      parentId: parent.id,
    }));

    const rows = toStreamRows([parent, ...children]);
    expect(rows.map((row) => row.step)).toEqual([
      "generate_questions.technical",
      "generate_questions.behavioural",
    ]);
  });

  it("keeps a childless step, so two coverage passes read as two lines", () => {
    const rows = toStreamRows([
      span("coverage_check", { pass: 1, gaps: 2 }),
      span("gap_fill", { covered: ["REQ-12"] }),
      span("coverage_check", { pass: 2, gaps: 1 }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => spanResult(row))).toEqual([
      "pass 1: 2 gaps",
      "REQ-12 covered",
      "pass 2: 1 gap",
    ]);
  });

  it("preserves the order the pipeline ran them in", () => {
    const rows = toStreamRows([span("extract_requirements"), span("fetch_homepage"), span("crawl_site")]);
    expect(rows.map((row) => row.step)).toEqual(["extract_requirements", "fetch_homepage", "crawl_site"]);
  });
});
