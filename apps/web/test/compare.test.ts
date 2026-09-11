import { describe, expect, it } from "vitest";
import type { InternalKit, Requirement, RequirementKind, RequirementPriority } from "@trao/kit";
import { buildComparison } from "../src/lib/compare";

/**
 * The comparison is the only place in the app that makes a claim spanning two kits — "three of
 * your four companies want this" — so the grouping behind it is worth pinning down. Every case
 * here is about when two requirements from different postings are, and are not, the same one.
 */

function req(id: string, text: string, priority: RequirementPriority, kind: RequirementKind = "technical"): Requirement {
  return { id, text, kind, priority };
}

function kit(company: string, requirements: Requirement[]): InternalKit {
  return {
    id: `kit_${company}`,
    createdAt: 0,
    version: 1,
    role: { title: "Engineer", company, location: "", summary: "", responsibilities: [] },
    companyBrief: { summary: "", whatTheyDo: "", hiringProcess: "", sources: [], pagesUsed: [], gaps: [], edited: false, origin: "generated" },
    requirements,
    questions: [],
    flashcards: [],
    schedule: { daysAvailable: 1, days: [] },
    coverage: { passes: 1, uncoveredRequirementIds: [] },
  };
}

describe("buildComparison", () => {
  it("groups the same requirement phrased differently across two kits", () => {
    const comparison = buildComparison([
      { kitId: "a", kit: kit("Vaultline", [req("r1", "Distributed systems", "must")]) },
      { kitId: "b", kit: kit("Northbeam", [req("r1", "Experience with distributed systems at scale", "nice")]) },
    ]);

    expect(comparison.rows).toHaveLength(1);
    const row = comparison.rows[0]!;
    expect(row.wanted).toBe(2);
    expect(row.musts).toBe(1);
    expect(row.byKit).toEqual({ a: "must", b: "nice" });
    // The label is the least padded phrasing, not whichever kit happened to load first.
    expect(row.label).toBe("Distributed systems");
  });

  it("keeps unrelated requirements apart", () => {
    const comparison = buildComparison([
      { kitId: "a", kit: kit("Vaultline", [req("r1", "Postgres partitioning", "must")]) },
      { kitId: "b", kit: kit("Northbeam", [req("r1", "Kafka consumer groups", "must")]) },
    ]);

    expect(comparison.rows).toHaveLength(2);
    expect(comparison.shared).toHaveLength(0);
  });

  it("never merges across kind, however much vocabulary is shared", () => {
    const comparison = buildComparison([
      { kitId: "a", kit: kit("Vaultline", [req("r1", "Payments domain depth", "must", "domain")]) },
      { kitId: "b", kit: kit("Northbeam", [req("r1", "Payments domain depth", "must", "technical")]) },
    ]);

    expect(comparison.rows).toHaveLength(2);
  });

  it("counts one kit once, even when it lists the same thing twice", () => {
    const comparison = buildComparison([
      {
        kitId: "a",
        kit: kit("Vaultline", [
          req("r1", "Distributed systems", "must"),
          req("r2", "Distributed systems design", "nice"),
        ]),
      },
      { kitId: "b", kit: kit("Northbeam", [req("r1", "Distributed systems", "must")]) },
    ]);

    const top = comparison.rows[0]!;
    // Two votes at most from two kits — a posting repeating itself is not a second company.
    expect(top.wanted).toBeLessThanOrEqual(2);
    expect(Object.keys(top.byKit)).toHaveLength(top.wanted);
  });

  it("orders by how many postings want the thing", () => {
    const shared = req("r1", "Distributed systems", "must");
    const comparison = buildComparison([
      { kitId: "a", kit: kit("A", [req("r0", "Kafka streams", "must"), shared]) },
      { kitId: "b", kit: kit("B", [shared]) },
      { kitId: "c", kit: kit("C", [shared]) },
    ]);

    expect(comparison.rows[0]!.label).toBe("Distributed systems");
    expect(comparison.rows[0]!.wanted).toBe(3);
    expect(comparison.shared.map((row) => row.label)).toEqual(["Distributed systems"]);
  });

  it("reports nothing shared when a single kit is compared", () => {
    const comparison = buildComparison([
      { kitId: "a", kit: kit("Vaultline", [req("r1", "Distributed systems", "must")]) },
    ]);

    // One kit trivially "shares" everything with itself, which would be a meaningless headline.
    expect(comparison.shared).toHaveLength(0);
    expect(comparison.rows).toHaveLength(1);
  });

  it("marks a requirement absent rather than blank when a posting never asked", () => {
    const comparison = buildComparison([
      { kitId: "a", kit: kit("A", [req("r1", "On-call ownership", "must", "behavioural")]) },
      { kitId: "b", kit: kit("B", [req("r1", "Kafka streams", "must")]) },
    ]);

    const oncall = comparison.rows.find((row) => row.label === "On-call ownership")!;
    expect(oncall.byKit["b"]).toBeUndefined();
    expect(oncall.wanted).toBe(1);
  });
});
