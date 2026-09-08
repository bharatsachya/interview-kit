import { describe, expect, it } from "vitest";
import { KitError, type Span } from "@trao/contracts";
import { FixedClock, InMemoryTracer, NoopTracer } from "../src/index";

function byStep(spans: Span[], step: string): Span {
  const span = spans.find((s) => s.step === step);
  if (!span) throw new Error(`no span named ${step}; got ${spans.map((s) => s.step).join(", ")}`);
  return span;
}

describe("InMemoryTracer", () => {
  it("records nested spans with correct parent ids", async () => {
    const tracer = new InMemoryTracer(new FixedClock(1000));

    await tracer.span("generate_kit", async (s) => {
      await s.child("generate_questions", async (q) => {
        await q.child("category:technical", async () => {});
        await q.child("category:behavioural", async () => {});
      });
    });

    const spans = tracer.export();
    const root = byStep(spans, "generate_kit");
    const questions = byStep(spans, "generate_questions");

    expect(root.parentId).toBeNull();
    expect(questions.parentId).toBe(root.id);
    expect(byStep(spans, "category:technical").parentId).toBe(questions.id);
    expect(byStep(spans, "category:behavioural").parentId).toBe(questions.id);
  });

  it("nests implicitly when tracer.span is called from inside a span", async () => {
    // A step should not have to thread its handle through every helper it calls.
    const tracer = new InMemoryTracer(new FixedClock());
    const helper = async (): Promise<void> => {
      await tracer.span("inner", async () => {});
    };

    await tracer.span("outer", async () => {
      await helper();
    });

    const spans = tracer.export();
    expect(byStep(spans, "inner").parentId).toBe(byStep(spans, "outer").id);
  });

  it("parents concurrent siblings correctly", async () => {
    // The case a current-span stack gets wrong: two overlapping fetches under one step.
    const tracer = new InMemoryTracer(new FixedClock());

    await tracer.span("crawl_site", async (s) => {
      await Promise.all([
        s.child("fetch:a", async () => {
          await Promise.resolve();
        }),
        s.child("fetch:b", async () => {}),
      ]);
    });

    const spans = tracer.export();
    const crawl = byStep(spans, "crawl_site");
    expect(byStep(spans, "fetch:a").parentId).toBe(crawl.id);
    expect(byStep(spans, "fetch:b").parentId).toBe(crawl.id);
  });

  it("returns spans in start order, not completion order", async () => {
    const tracer = new InMemoryTracer(new FixedClock());
    await tracer.span("outer", async (s) => {
      await s.child("inner", async () => {});
    });

    expect(tracer.export().map((s) => s.step)).toEqual(["outer", "inner"]);
  });

  it("records a throwing span as failed and still propagates the error", async () => {
    const tracer = new InMemoryTracer(new FixedClock());

    await expect(
      tracer.span("fetch_homepage", async () => {
        throw new KitError("COMPANY_UNREACHABLE", "Company site unreachable after 3 retries.");
      }),
    ).rejects.toThrow("Company site unreachable after 3 retries.");

    const span = byStep(tracer.export(), "fetch_homepage");
    expect(span.status).toBe("failed");
    expect(span.error).toEqual({
      code: "COMPANY_UNREACHABLE",
      message: "Company site unreachable after 3 retries.",
    });
  });

  it("marks a failure even when the step called skip() first", async () => {
    const tracer = new InMemoryTracer(new FixedClock());

    await expect(
      tracer.span("search_discussion", async (s) => {
        s.skip("no_key");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(byStep(tracer.export(), "search_discussion").status).toBe("failed");
  });

  it("records skip() as status skipped with the reason in attrs", async () => {
    const tracer = new InMemoryTracer(new FixedClock());

    await tracer.span("search_discussion", async (s) => {
      s.skip("no_key");
    });

    const span = byStep(tracer.export(), "search_discussion");
    expect(span.status).toBe("skipped");
    expect(span.attrs["skip_reason"]).toBe("no_key");
  });

  it("measures duration from the injected clock", async () => {
    const clock = new FixedClock(1000);
    const tracer = new InMemoryTracer(clock);

    await tracer.span("crawl_site", async () => {
      await clock.sleep(4200);
    });

    const span = byStep(tracer.export(), "crawl_site");
    expect(span.startedAt).toBe(1000);
    expect(span.endedAt).toBe(5200);
    expect(span.durationMs).toBe(4200);
  });

  it("hands back copies, so a caller cannot edit the recorded trace", async () => {
    const tracer = new InMemoryTracer(new FixedClock());
    await tracer.span("extract_requirements", async (s) => s.set("must_count", 7));

    const first = tracer.export();
    (first[0] as Span).attrs["must_count"] = 999;

    expect(byStep(tracer.export(), "extract_requirements").attrs["must_count"]).toBe(7);
  });

  it("keeps the last value when an attribute is set twice", async () => {
    const tracer = new InMemoryTracer(new FixedClock());
    await tracer.span("coverage_check", async (s) => {
      s.set("pass", 1);
      s.setAll({ pass: 2, gaps: ["r3", "r6"] });
    });

    const span = byStep(tracer.export(), "coverage_check");
    expect(span.attrs).toEqual({ pass: 2, gaps: ["r3", "r6"] });
  });
});

describe("NoopTracer", () => {
  it("satisfies the interface and records nothing", async () => {
    const tracer = new NoopTracer();

    const result = await tracer.span("generate_kit", async (s) => {
      s.set("jd_chars", 4820);
      s.skip("irrelevant");
      return s.child("nested", async () => "value");
    });

    expect(result).toBe("value");
    expect(tracer.export()).toEqual([]);
  });

  it("still propagates errors", async () => {
    const tracer = new NoopTracer();
    await expect(
      tracer.span("boom", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
