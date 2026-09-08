import { describe, expect, it } from "vitest";
import type { OutputSchema } from "@trao/contracts";
import { kitJsonSchema, validateKitJSON, type KitJSON } from "../src/appendix-a";
import { makeKitJSON } from "./fixtures";

/** Mandatory test area: structure validation. */
describe("Appendix A validation", () => {
  it("accepts a valid kit", () => {
    expect(validateKitJSON(makeKitJSON())).toEqual({ ok: true, errors: [] });
  });

  it.each([0, 4, -1, 2.5])("rejects difficulty %s", (difficulty) => {
    const kit = makeKitJSON();
    (kit["questions"] as Record<string, unknown>[])[0]!["difficulty"] = difficulty;
    expect(validateKitJSON(kit).ok).toBe(false);
  });

  it.each([1, 2, 3])("accepts difficulty %s", (difficulty) => {
    const kit = makeKitJSON();
    (kit["questions"] as Record<string, unknown>[])[0]!["difficulty"] = difficulty;
    expect(validateKitJSON(kit).ok).toBe(true);
  });

  it("rejects a float minutes value", () => {
    const kit = makeKitJSON();
    const schedule = kit["schedule"] as { days: Record<string, unknown>[] };
    schedule.days[0]!["minutes"] = 45.5;

    const result = validateKitJSON(kit);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("minutes");
  });

  it("rejects a missing location", () => {
    const kit = makeKitJSON();
    delete (kit["role"] as Record<string, unknown>)["location"];

    const result = validateKitJSON(kit);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("location");
  });

  it("accepts an empty location, which is what a posting that does not say produces", () => {
    const kit = makeKitJSON();
    (kit["role"] as Record<string, unknown>)["location"] = "";
    expect(validateKitJSON(kit).ok).toBe(true);
  });

  it("rejects a question referencing a requirement that does not exist", () => {
    const kit = makeKitJSON();
    (kit["questions"] as Record<string, unknown>[])[0]!["requirement_ids"] = ["r1", "r99"];

    const result = validateKitJSON(kit);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("r99");
  });

  it("rejects a flashcard referencing a requirement that does not exist", () => {
    const kit = makeKitJSON();
    (kit["flashcards"] as Record<string, unknown>[])[0]!["requirement_ids"] = ["r99"];
    expect(validateKitJSON(kit).ok).toBe(false);
  });

  it("rejects a day referencing a question that does not exist", () => {
    const kit = makeKitJSON();
    const schedule = kit["schedule"] as { days: Record<string, unknown>[] };
    schedule.days[0]!["question_ids"] = ["q1", "q404"];

    const result = validateKitJSON(kit);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("q404");
  });

  it("rejects days.length that disagrees with days_available", () => {
    const kit = makeKitJSON();
    (kit["schedule"] as Record<string, unknown>)["days_available"] = 5;

    const result = validateKitJSON(kit);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("days_available is 5");
  });

  it("rejects the same question scheduled on two days", () => {
    const kit = makeKitJSON();
    kit["schedule"] = {
      days_available: 2,
      days: [
        { day: 1, focus: "a", question_ids: ["q1"], minutes: 20 },
        { day: 2, focus: "b", question_ids: ["q1"], minutes: 20 },
      ],
    };

    const result = validateKitJSON(kit);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("scheduled on both day 1 and day 2");
  });

  it.each(["technical", "behavioural", "system-design", "company-fit"])("accepts category %s", (category) => {
    const kit = makeKitJSON();
    (kit["questions"] as Record<string, unknown>[])[0]!["category"] = category;
    expect(validateKitJSON(kit).ok).toBe(true);
  });

  it("rejects a category outside the four", () => {
    const kit = makeKitJSON();
    (kit["questions"] as Record<string, unknown>[])[0]!["category"] = "culture";
    expect(validateKitJSON(kit).ok).toBe(false);
  });

  it("rejects an unknown top-level field, so a provenance leak cannot pass silently", () => {
    const kit = makeKitJSON();
    (kit["questions"] as Record<string, unknown>[])[0]!["pinned"] = true;
    expect(validateKitJSON(kit).ok).toBe(false);
  });

  it("reports every problem at once, with a path", () => {
    const kit = makeKitJSON();
    (kit["questions"] as Record<string, unknown>[])[0]!["difficulty"] = 9;
    delete (kit["role"] as Record<string, unknown>)["location"];

    const result = validateKitJSON(kit);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.some((e) => e.startsWith("role.location"))).toBe(true);
    expect(result.errors.some((e) => e.startsWith("questions.0.difficulty"))).toBe(true);
  });

  it("satisfies the OutputSchema contract, so the LLM gateway can validate with it directly", () => {
    // Compile-time assertion: this line fails to build if Zod and contracts ever diverge.
    const schema: OutputSchema<KitJSON> = kitJsonSchema;
    expect(schema.safeParse({}).success).toBe(false);
  });
});
