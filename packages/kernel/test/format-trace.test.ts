import { describe, expect, it } from "vitest";
import { FixedClock, InMemoryTracer, formatTrace } from "../src/index";

describe("formatTrace", () => {
  it("renders the tree with durations, statuses and attributes", async () => {
    const clock = new FixedClock(0);
    const tracer = new InMemoryTracer(clock);

    await tracer.span("generate_kit", async (root) => {
      await root.child("extract_requirements", async (s) => {
        s.setAll({ jd_chars: 4820, must_count: 7 });
        await clock.sleep(3_100);
      });
      await root.child("search_discussion", async (s) => s.skip("no_key"));
      await root.child("coverage_check", async (s) => {
        s.setAll({ pass: 1, gaps: ["r3", "r6"] });
      });
    });

    const output = formatTrace(tracer.export());

    expect(output).toContain("▸ generate_kit");
    expect(output).toContain("  ▸ extract_requirements");
    expect(output).toMatch(/extract_requirements\s+3\.1s\s+ok\s+jd_chars=4820 must_count=7/);
    expect(output).toMatch(/search_discussion\s+0\.0s\s+skip\s+skip_reason=no_key/);
    expect(output).toContain("gaps=[r3,r6]");
  });

  it("shows the error code on a failed span", async () => {
    const tracer = new InMemoryTracer(new FixedClock());
    await tracer
      .span("fetch_homepage", async () => {
        throw new Error("connect ETIMEDOUT");
      })
      .catch(() => {});

    expect(formatTrace(tracer.export())).toContain("fail");
    expect(formatTrace(tracer.export())).toContain("connect ETIMEDOUT");
  });

  it("says so rather than printing nothing when there are no spans", () => {
    expect(formatTrace([])).toBe("(no spans)");
  });
});
