import { describe, expect, it } from "vitest";
import type { Span, SpanStatus } from "@trao/contracts";
import { spanNote, stepLabel, toPhaseViews, unclaimedSpans } from "../src/lib/pipeline-phases";

/**
 * The progress screen's one piece of real logic.
 *
 * The rule it has to hold is the product's, not the display's: honest degradation is a success.
 * A skipped search or an unreachable company site must never be drawn the way a failure is,
 * because the run carried on and the kit is fine. These tests exist so that rule survives
 * somebody later "tidying up" the state machine.
 */

let counter = 0;
function span(step: string, status: SpanStatus = "ok", attrs: Record<string, unknown> = {}, error?: Span["error"]): Span {
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
    ...(error ? { error } : {}),
  };
}

const RESEARCH = ["fetch_homepage", "crawl_site", "search_discussion", "generate_brief"];

function research(spans: Span[], done = true) {
  const view = toPhaseViews(spans, done).find((candidate) => candidate.phase.id === "research");
  if (!view) throw new Error("research phase missing");
  return view;
}

describe("toPhaseViews", () => {
  it("is pending before any of its steps have run", () => {
    expect(research([], false).state).toBe("pending");
  });

  it("is running while only some of its steps have finished", () => {
    expect(research([span("fetch_homepage"), span("crawl_site")], false).state).toBe("running");
  });

  it("is done when every step finished cleanly", () => {
    expect(research(RESEARCH.map((step) => span(step))).state).toBe("done");
  });

  it("is degraded, not failed, when the discussion search was skipped", () => {
    const spans = RESEARCH.map((step) =>
      step === "search_discussion"
        ? span(step, "skipped", { reason: "No search provider configured." })
        : span(step),
    );
    expect(research(spans).state).toBe("degraded");
  });

  it("is degraded, not failed, when the brief was written from the description alone", () => {
    const spans = RESEARCH.map((step) =>
      step === "generate_brief" ? span(step, "ok", { degraded: "Written from the job description alone." }) : span(step),
    );
    expect(research(spans).state).toBe("degraded");
  });

  it("is failed only when a step actually errored", () => {
    const spans = RESEARCH.map((step) =>
      step === "fetch_homepage"
        ? span(step, "failed", {}, { code: "COMPANY_UNREACHABLE", message: "Could not reach it." })
        : span(step),
    );
    expect(research(spans).state).toBe("failed");
  });

  it("does not hold a phase at running once the job is done — a skipped step still counts", () => {
    // The site was unreachable, so crawl_site never emitted. The phase is finished, not stuck.
    const spans = [span("fetch_homepage", "failed", {}, { code: "X", message: "no" }), span("generate_brief")];
    expect(research(spans, true).state).toBe("failed");
    expect(research([span("fetch_homepage"), span("generate_brief")], true).state).toBe("done");
  });

  it("sums elapsed time from the spans rather than from a clock", () => {
    expect(research(RESEARCH.map((step) => span(step))).elapsedMs).toBe(4000);
  });

  it("ignores child spans when deciding a phase's state", () => {
    // The four per-category generation calls are children; counting them would make the
    // "writing" phase look like it had more steps than it does.
    const child: Span = { ...span("generate_questions.technical"), parentId: "s-parent" };
    const views = toPhaseViews([span("generate_questions"), span("coverage_check"), span("gap_fill"), child], true);
    const write = views.find((candidate) => candidate.phase.id === "write");
    expect(write?.spans).toHaveLength(3);
    expect(write?.state).toBe("done");
  });
});

describe("unclaimedSpans", () => {
  it("surfaces a step no phase knows about rather than dropping it", () => {
    const extra = unclaimedSpans([span("extract_requirements"), span("some_new_step")]);
    expect(extra.map((s) => s.step)).toEqual(["some_new_step"]);
  });
});

describe("spanNote", () => {
  it("prefers the error message, then the skip reason, then the degradation note", () => {
    expect(spanNote(span("x", "failed", { reason: "r" }, { code: "C", message: "boom" }))).toBe("boom");
    expect(spanNote(span("x", "skipped", { reason: "no key" }))).toBe("no key");
    expect(spanNote(span("x", "ok", { degraded: "partial" }))).toBe("partial");
    expect(spanNote(span("x"))).toBeNull();
  });
});

describe("stepLabel", () => {
  it("falls back to a readable form of an unknown step name", () => {
    expect(stepLabel("crawl_site")).toBe("Crawling for a hiring page");
    expect(stepLabel("some_new_step")).toBe("some new step");
  });
});
