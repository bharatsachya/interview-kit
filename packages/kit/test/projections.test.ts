import { beforeEach, describe, expect, it } from "vitest";
import { validateKitJSON } from "../src/appendix-a";
import { archiveQuestion, regenerateCategory } from "../src/edits";
import { getKitForBuilder, toKitJSON, tryToKitJSON } from "../src/projections";
import { makeKit, makeQuestion, resetIds } from "./fixtures";

beforeEach(resetIds);

describe("toKitJSON", () => {
  it("drops an archived question from both the question list and the schedule days", () => {
    const kit = archiveQuestion(makeKit(), "q1");
    const output = toKitJSON(kit);

    expect(output.questions.map((q) => q.id)).toEqual(["q2"]);
    expect(output.schedule.days.flatMap((d) => d.question_ids)).not.toContain("q1");
  });

  it("places an active question that was in no day", () => {
    const kit = makeKit();
    kit.questions.push(makeQuestion({ id: "q9", category: "technical", requirementIds: ["r1"], order: 9 }));

    const output = toKitJSON(kit);

    expect(output.questions.map((q) => q.id)).toContain("q9");
    expect(output.schedule.days.flatMap((d) => d.question_ids)).toContain("q9");
  });

  it("emits no provenance fields", () => {
    const output = toKitJSON(makeKit());
    const serialised = JSON.stringify(output);

    for (const field of ["origin", "pinned", "active", "order", "edited", "questionId"]) {
      expect(serialised).not.toContain(`"${field}"`);
    }
  });

  it("keeps day minutes an integer equal to the sum of the day's questions", () => {
    const output = toKitJSON(makeKit());

    // q1 is difficulty 3 (30 minutes), q2 is difficulty 1 (10 minutes).
    expect(output.schedule.days.map((d) => d.minutes)).toEqual([30, 10]);
    for (const day of output.schedule.days) expect(Number.isInteger(day.minutes)).toBe(true);
  });

  it("recomputes minutes after an archive, rather than leaving a stale total", () => {
    const kit = archiveQuestion(makeKit(), "q1");
    const output = toKitJSON(kit);

    expect(output.schedule.days.find((d) => d.day === 1)?.minutes).toBe(0);
  });

  it("produces a document that passes Appendix A validation", () => {
    expect(validateKitJSON(toKitJSON(makeKit()))).toEqual({ ok: true, errors: [] });
  });

  it("orders questions by category as specified, then by the user's ordering", () => {
    const kit = makeKit({
      questions: [
        makeQuestion({ id: "q1", category: "company-fit", order: 0 }),
        makeQuestion({ id: "q2", category: "technical", order: 1 }),
        makeQuestion({ id: "q3", category: "technical", order: 0 }),
      ],
      schedule: { daysAvailable: 1, days: [{ day: 1, focus: "", questionIds: [], minutes: 0, edited: false }] },
    });

    expect(toKitJSON(kit).questions.map((q) => q.id)).toEqual(["q3", "q2", "q1"]);
  });

  it("reports rather than throws through tryToKitJSON when a kit is malformed", () => {
    const kit = makeKit();
    kit.schedule.daysAvailable = 7; // days.length is 2

    const result = tryToKitJSON(kit);
    expect(result.ok).toBe(false);
    expect(result.kit).toBeNull();
    expect(result.errors.join(" ")).toContain("days_available is 7");
  });

  it("throws KIT_VALIDATION_FAILED when a malformed kit reaches the throwing projection", () => {
    const kit = makeKit();
    kit.schedule.daysAvailable = 7;

    expect(() => toKitJSON(kit)).toThrow(/Appendix A validation/);
  });

  it("does not mutate the kit it was given", () => {
    const kit = makeKit();
    const before = structuredClone(kit);
    toKitJSON(kit);
    expect(kit).toEqual(before);
  });
});

describe("getKitForBuilder", () => {
  it("retains provenance flags", () => {
    const builder = getKitForBuilder(makeKit());
    const question = builder.questions[0];

    expect(question).toMatchObject({ origin: "generated", pinned: false, active: true });
    expect(typeof question?.order).toBe("number");
  });

  it("hides archived items", () => {
    const builder = getKitForBuilder(archiveQuestion(makeKit(), "q1"));

    expect(builder.questions.map((q) => q.id)).toEqual(["q2"]);
    expect(builder.schedule.days.flatMap((d) => d.questionIds)).not.toContain("q1");
  });

  it("agrees with toKitJSON about which questions are on which day", () => {
    // The two projections both run repair precisely so this can never drift.
    const kit = archiveQuestion(makeKit(), "q1");
    kit.questions.push(makeQuestion({ id: "q9", order: 9 }));

    const builder = getKitForBuilder(kit);
    const output = toKitJSON(kit);

    expect(builder.schedule.days.map((d) => d.questionIds)).toEqual(
      output.schedule.days.map((d) => d.question_ids),
    );
  });
});

describe("archive → regenerate → serialize", () => {
  it("still passes Appendix A validation with no dangling ids", () => {
    let kit = makeKit();
    kit = archiveQuestion(kit, "q1");
    kit = regenerateCategory(kit, "behavioural", [
      { id: "q10", prompt: "New behavioural?", answerOutline: "Outline.", difficulty: 2, requirementIds: ["r2"] },
      { id: "q11", prompt: "Another one?", answerOutline: "Outline.", difficulty: 1, requirementIds: ["r2"] },
    ]);

    const output = toKitJSON(kit);

    expect(validateKitJSON(output)).toEqual({ ok: true, errors: [] });
    expect(output.questions.map((q) => q.id).sort()).toEqual(["q10", "q11"]);

    const scheduled = output.schedule.days.flatMap((d) => d.question_ids);
    expect(scheduled.sort()).toEqual(["q10", "q11"]);
    expect(new Set(scheduled).size).toBe(scheduled.length);
  });
});
