import { beforeEach, describe, expect, it } from "vitest";
import { repairSchedule } from "../src/repair";
import { makeQuestion, resetIds } from "./fixtures";
import type { InternalSchedule } from "../src/types";

beforeEach(resetIds);

const schedule = (days: { day: number; questionIds: string[]; edited?: boolean }[]): InternalSchedule => ({
  daysAvailable: days.length,
  days: days.map((d) => ({
    day: d.day,
    focus: `Day ${d.day}`,
    questionIds: d.questionIds,
    minutes: 0,
    edited: d.edited ?? false,
  })),
});

describe("repairSchedule", () => {
  it("drops archived question ids from days", () => {
    const questions = [
      makeQuestion({ id: "q1", active: false, order: 0 }),
      makeQuestion({ id: "q2", active: true, order: 1 }),
    ];

    const repaired = repairSchedule(schedule([{ day: 1, questionIds: ["q1", "q2"] }]), questions);
    expect(repaired.days[0]?.questionIds).toEqual(["q2"]);
  });

  it("drops ids for questions that do not exist at all", () => {
    const repaired = repairSchedule(
      schedule([{ day: 1, questionIds: ["ghost"] }]),
      [makeQuestion({ id: "q1", order: 0 })],
    );

    expect(repaired.days[0]?.questionIds).toEqual(["q1"]);
  });

  it("places an active question that appears on no day", () => {
    const questions = [makeQuestion({ id: "q1", order: 0 }), makeQuestion({ id: "q2", order: 1 })];
    const repaired = repairSchedule(schedule([{ day: 1, questionIds: ["q1"] }, { day: 2, questionIds: [] }]), questions);

    expect(repaired.days.flatMap((d) => d.questionIds)).toContain("q2");
  });

  it("places an orphan on the lightest day, earliest day breaking a tie", () => {
    const questions = [
      makeQuestion({ id: "heavy", difficulty: 3, order: 0 }),
      makeQuestion({ id: "light", difficulty: 1, order: 1 }),
      makeQuestion({ id: "orphan", difficulty: 1, order: 2 }),
    ];

    const repaired = repairSchedule(
      schedule([
        { day: 1, questionIds: ["heavy"] },
        { day: 2, questionIds: ["light"] },
      ]),
      questions,
    );

    expect(repaired.days.find((d) => d.day === 2)?.questionIds).toContain("orphan");
  });

  it("avoids a day the user edited while any unedited day exists", () => {
    const questions = [makeQuestion({ id: "orphan", order: 0 })];
    const repaired = repairSchedule(
      schedule([
        { day: 1, questionIds: [], edited: true },
        { day: 2, questionIds: [] },
      ]),
      questions,
    );

    expect(repaired.days.find((d) => d.day === 1)?.questionIds).toEqual([]);
    expect(repaired.days.find((d) => d.day === 2)?.questionIds).toEqual(["orphan"]);
  });

  it("still places the question when every day is edited", () => {
    // An unscheduled question is worse than a slightly disturbed day.
    const questions = [makeQuestion({ id: "orphan", order: 0 })];
    const repaired = repairSchedule(
      schedule([
        { day: 1, questionIds: [], edited: true },
        { day: 2, questionIds: [], edited: true },
      ]),
      questions,
    );

    expect(repaired.days.flatMap((d) => d.questionIds)).toEqual(["orphan"]);
  });

  it("leaves an edited day's focus untouched", () => {
    const days = schedule([{ day: 1, questionIds: [], edited: true }]);
    days.days[0]!.focus = "My own plan";

    const repaired = repairSchedule(days, [makeQuestion({ id: "q1", order: 0 })]);
    expect(repaired.days[0]?.focus).toBe("My own plan");
    expect(repaired.days[0]?.edited).toBe(true);
  });

  it("de-duplicates a question scheduled on two days, keeping the earlier one", () => {
    const repaired = repairSchedule(
      schedule([
        { day: 1, questionIds: ["q1"] },
        { day: 2, questionIds: ["q1"] },
      ]),
      [makeQuestion({ id: "q1", order: 0 })],
    );

    expect(repaired.days[0]?.questionIds).toEqual(["q1"]);
    expect(repaired.days[1]?.questionIds).toEqual([]);
  });

  it("recomputes minutes from the day's actual questions", () => {
    const questions = [
      makeQuestion({ id: "q1", difficulty: 3, order: 0 }), // 30
      makeQuestion({ id: "q2", difficulty: 1, order: 1 }), // 10
    ];

    const days = schedule([{ day: 1, questionIds: ["q1", "q2"] }]);
    days.days[0]!.minutes = 999; // stale

    expect(repairSchedule(days, questions).days[0]?.minutes).toBe(40);
  });

  it("never changes the number of days", () => {
    const repaired = repairSchedule(schedule([{ day: 1, questionIds: [] }, { day: 2, questionIds: [] }]), []);
    expect(repaired.days).toHaveLength(2);
    expect(repaired.daysAvailable).toBe(2);
  });

  it("is idempotent", () => {
    const questions = [makeQuestion({ id: "q1", order: 0 }), makeQuestion({ id: "q2", active: false, order: 1 })];
    const once = repairSchedule(schedule([{ day: 1, questionIds: ["q2"] }]), questions);
    const twice = repairSchedule(once, questions);

    expect(twice).toEqual(once);
  });

  it("does not mutate the schedule it was given", () => {
    const original = schedule([{ day: 1, questionIds: ["gone"] }]);
    const before = structuredClone(original);

    repairSchedule(original, [makeQuestion({ id: "q1", order: 0 })]);
    expect(original).toEqual(before);
  });
});
