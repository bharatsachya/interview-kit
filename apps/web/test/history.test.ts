import { describe, expect, it } from "vitest";
import type { JobSummary, KitSummary } from "../src/lib/api/types";
import { kitCount, kitsOf, mergeHistory, runLabel } from "../src/lib/history";

const kit = (id: string, createdAt: number, over: Partial<KitSummary> = {}): KitSummary => ({
  id,
  title: "Senior Backend Engineer",
  company: "Acme",
  days: 5,
  createdAt,
  revision: 1,
  ...over,
});

const job = (id: string, createdAt: number, over: Partial<JobSummary> = {}): JobSummary => ({
  id,
  label: "Acme — Senior Backend Engineer",
  status: "failed",
  kitId: null,
  createdAt,
  progress: null,
  retryable: true,
  error: { code: "TIMEOUT", message: "The operation was aborted due to timeout" },
  ...over,
});

describe("merging kits and runs into one history", () => {
  it("keeps a failed run, which has no kit and would otherwise vanish on reload", () => {
    const entries = mergeHistory([], [job("job_1", 100)]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("run");
  });

  it("drops a finished job in favour of the kit it produced", () => {
    // Both describe the same run, and the kit says more: company, role, days.
    const entries = mergeHistory(
      [kit("kit_1", 100)],
      [job("job_1", 100, { status: "done", kitId: "kit_1", error: null })],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("kit");
  });

  it("keeps a finished job whose kit has gone missing rather than losing the row", () => {
    const entries = mergeHistory([], [job("job_1", 100, { status: "done", kitId: "kit_gone", error: null })]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("run");
    expect(runLabel((entries[0] as { job: JobSummary }).job)).toBe("Kit missing");
  });

  it("interleaves runs and kits by time rather than grouping them apart", () => {
    const entries = mergeHistory(
      [kit("kit_old", 100), kit("kit_new", 300)],
      [job("job_mid", 200)],
    );

    expect(entries.map((entry) => entry.id)).toEqual(["kit_new", "job_mid", "kit_old"]);
  });

  it("counts only kits, so one failed run does not offer a comparison of one", () => {
    const entries = mergeHistory([kit("kit_1", 100)], [job("job_1", 200)]);

    expect(kitCount(entries)).toBe(1);
    expect(kitsOf(entries).map((k) => k.id)).toEqual(["kit_1"]);
  });

  it("says how far a running job got, and admits when it does not know", () => {
    expect(runLabel(job("j", 1, { status: "running", progress: { step: "crawl_site", stepIndex: 2, stepCount: 9 } }))).toBe(
      "Step 3 of 9",
    );
    expect(runLabel(job("j", 1, { status: "running", progress: null }))).toBe("Running");
    expect(runLabel(job("j", 1, { status: "queued" }))).toBe("Queued");
    expect(runLabel(job("j", 1, { status: "failed" }))).toBe("Failed");
  });
});
