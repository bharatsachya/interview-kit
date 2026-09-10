import { describe, expect, it } from "vitest";
import type { Span, SpanStatus } from "@trao/contracts";
import { parseStep, spanConsequence, spanResult, spanTone, stepLabel, toStreamRows } from "../src/lib/spans";

/**
 * The conversation's one piece of real logic.
 *
 * Two rules it has to hold, both the product's rather than the display's.
 *
 * Honest degradation is a success: a skipped search must never read the way a failure reads,
 * because the run carried on and the kit is fine.
 *
 * Every number shown comes off the span. The attribute names below are the pipeline's own, read
 * off a real run rather than invented here — an earlier version of this file guessed them, and
 * the result was a stream of steps with an arrow and nothing after it.
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

describe("parseStep", () => {
  it("reads the value out of the three step names that carry one", () => {
    expect(parseStep("category:system-design")).toEqual({ base: "category", category: "system-design" });
    expect(parseStep("coverage_check pass=2")).toEqual({ base: "coverage_check", pass: 2 });
    expect(parseStep("gap_fill REQ-09+REQ-11")).toEqual({ base: "gap_fill", ids: ["REQ-09", "REQ-11"] });
  });

  it("passes an ordinary step through untouched", () => {
    expect(parseStep("crawl_site")).toEqual({ base: "crawl_site" });
  });
});

describe("spanTone", () => {
  it("reads a skipped step as information, not as an error", () => {
    expect(spanTone(span("search_discussion", { skip_reason: "no_key" }, "skipped"))).toBe("info");
  });

  it("reserves trouble for a step that actually errored", () => {
    expect(spanTone(span("fetch_homepage", {}, "failed"))).toBe("trouble");
    expect(spanTone(span("generate_brief"))).toBe("done");
  });
});

describe("spanResult", () => {
  it("reports requirements as found and must-have", () => {
    expect(spanResult(span("extract_requirements", { requirement_count: 12, must_count: 7 }))).toBe(
      "12 found, 7 must-have",
    );
  });

  it("shows the host, not the careers path that was actually fetched", () => {
    // A long posting URL would push everything after it off the line, and the row is about
    // whether the company was reachable.
    expect(
      spanResult(span("fetch_homepage", { url: "https://www.example.com/careers/senior-backend" })),
    ).toBe("example.com");
  });

  it("counts pages crawled", () => {
    expect(spanResult(span("crawl_site", { pages_fetched: 6 }))).toBe("6 pages");
    expect(spanResult(span("crawl_site", { pages_fetched: 1 }))).toBe("1 page");
  });

  it("says a search found nothing rather than showing a bare zero", () => {
    expect(spanResult(span("search_discussion", { result_count: 0 }))).toBe("nothing found");
    expect(spanResult(span("search_discussion", { result_count: 3 }))).toBe("3 results");
  });

  it("names the degradation when the brief was written with no pages", () => {
    expect(spanResult(span("generate_brief", { wrote_without_model: true, sources_used: 0 }))).toBe(
      "from the job description alone",
    );
    expect(spanResult(span("generate_brief", { sources_used: 2 }))).toBe("2 sources");
  });

  it("counts each category's questions", () => {
    expect(spanResult(span("category:technical", { questions_out: 8 }))).toBe("8 questions");
    expect(spanResult(span("category:company-fit", { questions_out: 1 }))).toBe("1 question");
  });

  it("distinguishes the coverage passes and reports gaps as a count of ids", () => {
    // `gaps` is the list of uncovered must ids, not a number.
    expect(spanResult(span("coverage_check pass=1", { musts: 12, covered: 10, gaps: ["r3", "r7"] }))).toBe(
      "pass 1: 2 gaps",
    );
    expect(spanResult(span("coverage_check pass=2", { musts: 12, covered: 12, gaps: [] }))).toBe(
      "pass 2: all must-haves covered",
    );
  });

  it("does not congratulate itself on a posting that stated no must-haves", () => {
    expect(spanResult(span("coverage_check pass=1", { musts: 0, covered: 0, gaps: [] }))).toBe(
      "pass 1: no must-haves stated",
    );
  });

  it("names the requirements a gap fill closed, and the ones it could not", () => {
    expect(spanResult(span("gap_fill REQ-09+REQ-11", { accepted: true }))).toBe("REQ-09, REQ-11 covered");
    expect(spanResult(span("gap_fill REQ-09", { accepted: false, reason: "overlap" }))).toBe(
      "REQ-09 not closed",
    );
  });

  it("reads the schedule out of the days-built-over-days-asked string", () => {
    // The pipeline writes days as "5/5", not as a number.
    expect(spanResult(span("allocate_schedule", { days: "5/5", minutes: 330, placed: 12 }))).toBe(
      "5 days, 330 minutes",
    );
    expect(spanResult(span("allocate_schedule", { days: "1/1", minutes: 60 }))).toBe("1 day, 60 minutes");
  });

  it("reports what the finished kit contains", () => {
    expect(spanResult(span("serialize_kit", { valid: true, questions: 19, flashcards: 22 }))).toBe(
      "19 questions, 22 cards",
    );
  });

  it("shows nothing rather than inventing a number when the attribute is missing", () => {
    expect(spanResult(span("extract_requirements"))).toBeNull();
    expect(spanResult(span("allocate_schedule"))).toBeNull();
    expect(spanResult(span("generate_brief"))).toBeNull();
  });

  it("ignores an attribute of the wrong type instead of printing it", () => {
    expect(spanResult(span("extract_requirements", { requirement_count: "twelve" }))).toBeNull();
    expect(spanResult(span("derive_flashcards", { count: null }))).toBeNull();
  });
});

describe("skip reasons", () => {
  it("reads the reason the tracer actually writes, which is skip_reason", () => {
    // The kernel records `skip_reason`. Reading `reason` alone lost every explanation
    // silently — the row still rendered, just with nothing after "skipped".
    expect(spanResult(span("search_discussion", { skip_reason: "no_key" }, "skipped"))).toBe(
      "skipped, no search key",
    );
  });

  it("says why in words rather than in the tracer's vocabulary", () => {
    expect(spanResult(span("fetch_homepage", { skip_reason: "company_unreachable" }, "skipped"))).toBe(
      "skipped, could not reach the site",
    );
    expect(spanResult(span("crawl_site", { skip_reason: "no_homepage" }, "skipped"))).toBe(
      "skipped, nothing to crawl",
    );
    expect(spanResult(span("category:behavioural", { skip_reason: "no_requirements" }, "skipped"))).toBe(
      "skipped, no requirements to work from",
    );
  });

  it("degrades an unmapped reason to readable rather than to nothing", () => {
    expect(spanResult(span("crawl_site", { skip_reason: "some_new_reason" }, "skipped"))).toBe(
      "skipped, some new reason",
    );
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

  it("says the same thing whether the research step was skipped or failed", () => {
    // From the reader's side these are one outcome: there is no company material, and the kit
    // comes from the description. This is the case the 404 produced.
    expect(spanConsequence(span("fetch_homepage", { skip_reason: "company_unreachable" }, "skipped"))).toBe(
      "generating from the job description alone",
    );
    expect(spanConsequence(span("crawl_site", { skip_reason: "no_homepage" }, "skipped"))).toBe(
      "generating from the job description alone",
    );
  });

  it("leaves an unrelated skipped step without a consequence", () => {
    expect(spanConsequence(span("search_discussion", { skip_reason: "no_key" }, "skipped"))).toBeNull();
  });
});

describe("stepLabel", () => {
  it("names each generation call by its category", () => {
    expect(stepLabel("category:technical")).toBe("Generating technical questions");
    expect(stepLabel("category:company-fit")).toBe("Generating company-fit questions");
  });

  it("works from a step name alone, for the row shown while a step is in flight", () => {
    expect(stepLabel("crawl_site")).toBe("Crawling for hiring page");
    expect(stepLabel("coverage_check pass=2")).toBe("Checking coverage");
    expect(stepLabel("gap_fill REQ-09")).toBe("Filling gaps");
  });

  it("falls back to a readable form of a step it does not know", () => {
    expect(stepLabel("some_new_step")).toBe("some new step");
  });
});

describe("toStreamRows", () => {
  it("drops a parent in favour of its children — four calls say more than one step", () => {
    const parent = span("generate_questions", { questions_out: 19 });
    const children = ["technical", "behavioural"].map((category) => ({
      ...span(`category:${category}`, { questions_out: 4 }),
      parentId: parent.id,
    }));

    const rows = toStreamRows([parent, ...children]);
    expect(rows.map((row) => row.step)).toEqual(["category:technical", "category:behavioural"]);
  });

  it("keeps a childless step, so two coverage passes read as two lines", () => {
    const rows = toStreamRows([
      span("coverage_check pass=1", { musts: 3, covered: 1, gaps: ["r2", "r3"] }),
      span("gap_fill r2+r3", { accepted: true }),
      span("coverage_check pass=2", { musts: 3, covered: 3, gaps: [] }),
    ]);
    expect(rows.map((row) => spanResult(row))).toEqual([
      "pass 1: 2 gaps",
      "r2, r3 covered",
      "pass 2: all must-haves covered",
    ]);
  });

  it("preserves the order the pipeline ran them in", () => {
    const rows = toStreamRows([span("extract_requirements"), span("fetch_homepage"), span("crawl_site")]);
    expect(rows.map((row) => row.step)).toEqual(["extract_requirements", "fetch_homepage", "crawl_site"]);
  });
});
