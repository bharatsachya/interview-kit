import { beforeEach, describe, expect, it } from "vitest";
import { minutesForQuestions, repairSchedule, type InternalQuestion, type Requirement } from "@trao/kit";
import { allocateSchedule, reallocateSchedule } from "../src/allocate";
import { EMPTY_DAY_FOCUS, subjectOf } from "../src/focus";
import { questionWeight, indexRequirements } from "../src/weight";
import { REQUIREMENTS, realisticQuestions, question, resetIds } from "./fixtures";

beforeEach(resetIds);

const allocate = (questions: readonly InternalQuestion[], daysAvailable: number) =>
  allocateSchedule({ questions, requirements: REQUIREMENTS, daysAvailable });

/** Mandatory test area: schedule allocation. */
describe("allocateSchedule", () => {
  it.each([1, 5, 30, 60])("produces exactly %s day(s)", (days) => {
    const schedule = allocate(realisticQuestions(), days);

    expect(schedule.days).toHaveLength(days);
    expect(schedule.daysAvailable).toBe(days);
    expect(schedule.days.map((d) => d.day)).toEqual(Array.from({ length: days }, (_, i) => i + 1));
  });

  it("places every must-have requirement somewhere in the schedule", () => {
    const questions = realisticQuestions();
    const schedule = allocate(questions, 5);

    const byId = new Map(questions.map((q) => [q.id, q]));
    const scheduledRequirements = new Set(
      schedule.days.flatMap((d) => d.questionIds).flatMap((id) => byId.get(id)?.requirementIds ?? []),
    );

    for (const requirement of REQUIREMENTS.filter((r) => r.priority === "must")) {
      expect(scheduledRequirements, `must-have ${requirement.id} is unscheduled`).toContain(requirement.id);
    }
  });

  it.each([1, 3, 7, 30, 60])("keeps every minutes value an integer with %s days", (days) => {
    for (const day of allocate(realisticQuestions(), days).days) {
      expect(Number.isInteger(day.minutes)).toBe(true);
      expect(day.minutes).toBeGreaterThanOrEqual(0);
    }
  });

  it("lands harder and higher-priority material in earlier days", () => {
    const questions = realisticQuestions();
    const schedule = allocate(questions, 6);
    const byId = new Map(questions.map((q) => [q.id, q]));
    const requirements = indexRequirements(REQUIREMENTS);

    const averageWeights = schedule.days
      .filter((d) => d.questionIds.length > 0)
      .map((d) => {
        const weights = d.questionIds.map((id) => questionWeight(byId.get(id) as InternalQuestion, requirements));
        return weights.reduce((a, b) => a + b, 0) / weights.length;
      });

    for (let i = 1; i < averageWeights.length; i += 1) {
      expect(averageWeights[i - 1], `day ${i} is lighter than day ${i + 1}`).toBeGreaterThanOrEqual(
        averageWeights[i] as number,
      );
    }
  });

  it("puts the single hardest must-have on day one", () => {
    const questions = [
      question({ id: "easy-nice", difficulty: 1, requirementIds: ["r-nice"] }),
      question({ id: "hard-must", difficulty: 3, requirementIds: ["r-must"] }),
      question({ id: "medium-must", difficulty: 2, requirementIds: ["r-must"] }),
    ];

    expect(allocate(questions, 3).days[0]?.questionIds).toContain("hard-must");
  });

  /**
   * Regression guards. A fixed `total / days` target made every chunky question overshoot
   * immediately, so days 1..n-1 took one question each and the whole remainder landed on the
   * last day — 20-40 minutes a day then 120 the night before, exactly backwards. Both of these
   * fail against that allocator and pass against the one that recomputes each day's share.
   *
   * Neither asserts that minutes decrease monotonically: front-loading is by weight, and a day
   * of three medium questions legitimately out-minutes a day of two hard ones.
   */
  it.each([3, 5, 6, 9, 12])("never makes the last day the heaviest, with %s days", (days) => {
    const minutes = allocate(realisticQuestions(), days).days.map((d) => d.minutes);
    const lastDay = minutes.at(-1) as number;

    expect(lastDay).toBeLessThanOrEqual(Math.max(...minutes.slice(0, -1)));
    expect(lastDay).toBeLessThanOrEqual(minutes[0] as number);
  });

  it.each([3, 5, 6, 9, 12])("gives no single day an outsized share, with %s days", (days) => {
    const minutes = allocate(realisticQuestions(), days).days.map((d) => d.minutes);
    const average = minutes.reduce((a, b) => a + b, 0) / minutes.length;

    expect(Math.max(...minutes)).toBeLessThanOrEqual(average * 2);
  });

  it("resolves every scheduled id to a question that exists", () => {
    const questions = realisticQuestions();
    const ids = new Set(questions.map((q) => q.id));

    for (const day of allocate(questions, 7).days) {
      for (const id of day.questionIds) expect(ids).toContain(id);
    }
  });

  it("never lists the same question twice within one day", () => {
    for (const days of [1, 5, 60]) {
      for (const day of allocate(realisticQuestions(), days).days) {
        expect(new Set(day.questionIds).size).toBe(day.questionIds.length);
      }
    }
  });

  it("keeps each day's minutes equal to the sum of its questions", () => {
    const questions = realisticQuestions();
    const byId = new Map(questions.map((q) => [q.id, q]));

    for (const day of allocate(questions, 5).days) {
      const expected = minutesForQuestions(day.questionIds.map((id) => byId.get(id) as InternalQuestion));
      expect(day.minutes).toBe(expected);
    }
  });

  it("gives every day a focus derived in code, never blank", () => {
    for (const day of allocate(realisticQuestions(), 8).days) {
      expect(day.focus.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic — the same input twice gives the same schedule", () => {
    const a = allocate(realisticQuestions(), 9);
    const b = allocate(realisticQuestions(), 9);
    expect(a).toEqual(b);
  });

  it("ignores archived questions", () => {
    const questions = [question({ id: "live" }), question({ id: "archived", active: false })];
    const scheduled = allocate(questions, 2).days.flatMap((d) => d.questionIds);

    expect(scheduled).toContain("live");
    expect(scheduled).not.toContain("archived");
  });
});

describe("the 1-day case", () => {
  it("places everything on day 1 and drops nothing", () => {
    const questions = realisticQuestions();
    const schedule = allocate(questions, 1);

    expect(schedule.days).toHaveLength(1);
    expect(schedule.days[0]?.questionIds.sort()).toEqual(questions.map((q) => q.id).sort());
    expect(schedule.days[0]?.minutes).toBe(minutesForQuestions(questions));
  });

  it("drops nothing even when there is far more material than one day can hold", () => {
    const questions = Array.from({ length: 80 }, () => question({ difficulty: 3 }));
    expect(allocate(questions, 1).days[0]?.questionIds).toHaveLength(80);
  });
});

describe("the 60-day case — spaced review policy", () => {
  const questions = realisticQuestions();
  const schedule = allocate(questions, 60);

  it("produces exactly 60 days", () => {
    expect(schedule.days).toHaveLength(60);
  });

  it("leaves no day empty — an empty day reads as broken however valid it is", () => {
    for (const day of schedule.days) {
      expect(day.questionIds.length, `day ${day.day} is empty`).toBeGreaterThan(0);
      expect(day.minutes).toBeGreaterThan(0);
    }
  });

  it("teaches every question once before any day repeats material", () => {
    const firstAppearance = new Map<string, number>();
    for (const day of schedule.days) {
      for (const id of day.questionIds) {
        if (!firstAppearance.has(id)) firstAppearance.set(id, day.day);
      }
    }

    expect(firstAppearance.size).toBe(questions.length);
    const lastNewDay = Math.max(...firstAppearance.values());
    expect(lastNewDay).toBeLessThanOrEqual(questions.length);
  });

  it("labels the repeat days as review", () => {
    const reviewDays = schedule.days.filter((d) => d.focus.startsWith("Review"));
    expect(reviewDays.length).toBeGreaterThan(0);
    expect(reviewDays.length).toBe(60 - questions.length);
  });

  it("revisits every question before revisiting any of them twice", () => {
    const reviewCounts = new Map<string, number>();
    for (const day of schedule.days.filter((d) => d.focus.startsWith("Review"))) {
      for (const id of day.questionIds) reviewCounts.set(id, (reviewCounts.get(id) ?? 0) + 1);
    }

    const counts = [...reviewCounts.values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});

describe("more days than material", () => {
  it("leaves no day structurally broken", () => {
    const schedule = allocate([question({ id: "only" })], 5);

    expect(schedule.days).toHaveLength(5);
    for (const day of schedule.days) {
      expect(day.questionIds).toEqual(["only"]);
      expect(day.focus.length).toBeGreaterThan(0);
      expect(Number.isInteger(day.minutes)).toBe(true);
    }
  });

  it("says so honestly when there are no questions at all", () => {
    const schedule = allocate([], 3);

    expect(schedule.days).toHaveLength(3);
    for (const day of schedule.days) {
      expect(day.questionIds).toEqual([]);
      expect(day.minutes).toBe(0);
      expect(day.focus).toBe(EMPTY_DAY_FOCUS);
    }
  });
});

describe("reallocateSchedule", () => {
  it("leaves an edited day completely unchanged", () => {
    const questions = realisticQuestions();
    const original = allocate(questions, 5);
    const edited = {
      ...original,
      days: original.days.map((d, i) =>
        i === 1 ? { ...d, focus: "My own plan for Tuesday", questionIds: [questions[0]!.id], edited: true } : d,
      ),
    };

    const reallocated = reallocateSchedule(edited, { questions, requirements: REQUIREMENTS });

    expect(reallocated.days[1]).toEqual(edited.days[1]);
  });

  it("does not schedule a question that an edited day already claims", () => {
    const questions = realisticQuestions();
    const claimed = questions[0]!.id;
    const original = allocate(questions, 5);
    const edited = {
      ...original,
      days: original.days.map((d, i) => (i === 3 ? { ...d, questionIds: [claimed], edited: true } : d)),
    };

    const reallocated = reallocateSchedule(edited, { questions, requirements: REQUIREMENTS });
    const elsewhere = reallocated.days.filter((_, i) => i !== 3).flatMap((d) => d.questionIds);

    expect(elsewhere).not.toContain(claimed);
  });

  it("drops an archived id even from an edited day", () => {
    // The user's arrangement is preserved, but a dead reference cannot be.
    const questions = [question({ id: "live" }), question({ id: "gone", active: false })];
    const existing = {
      daysAvailable: 2,
      days: [
        { day: 1, focus: "Mine", questionIds: ["gone", "live"], minutes: 40, edited: true },
        { day: 2, focus: "", questionIds: [], minutes: 0, edited: false },
      ],
    };

    const reallocated = reallocateSchedule(existing, { questions, requirements: REQUIREMENTS });
    expect(reallocated.days[0]?.questionIds).toEqual(["live"]);
    expect(reallocated.days[0]?.focus).toBe("Mine");
  });

  it("keeps the day count", () => {
    const questions = realisticQuestions();
    const original = allocate(questions, 12);
    const reallocated = reallocateSchedule(original, { questions, requirements: REQUIREMENTS });

    expect(reallocated.days).toHaveLength(12);
    expect(reallocated.daysAvailable).toBe(12);
  });
});

/**
 * Repair lives in @trao/kit — but the skill names these three behaviours under scheduling, and
 * they matter most in combination with allocation, so they are asserted here too, against the
 * real allocator's output rather than a hand-built schedule.
 */
describe("repair, against an allocated schedule", () => {
  it("drops archived ids from days", () => {
    const questions = realisticQuestions();
    const schedule = allocate(questions, 5);
    const archived = questions.map((q) => (q.id === questions[0]!.id ? { ...q, active: false } : q));

    const repaired = repairSchedule(schedule, archived);
    expect(repaired.days.flatMap((d) => d.questionIds)).not.toContain(questions[0]!.id);
  });

  it("places a newly-active unscheduled question", () => {
    const questions = realisticQuestions();
    const schedule = allocate(questions, 5);
    const withNewcomer = [...questions, question({ id: "added-by-hand", origin: "manual", order: 999 })];

    const repaired = repairSchedule(schedule, withNewcomer);
    expect(repaired.days.flatMap((d) => d.questionIds)).toContain("added-by-hand");
  });

  it("leaves an edited day unchanged", () => {
    const questions = realisticQuestions();
    const schedule = allocate(questions, 5);
    const edited = {
      ...schedule,
      days: schedule.days.map((d, i) => (i === 0 ? { ...d, focus: "My own plan", edited: true } : d)),
    };

    const repaired = repairSchedule(edited, questions);
    expect(repaired.days[0]?.focus).toBe("My own plan");
    expect(repaired.days[0]?.questionIds).toEqual(edited.days[0]?.questionIds);
  });
});

/**
 * Day focus names the subject, not the shape of the questions.
 *
 * The first version labelled days by category, which gave "Technical depth" to three days and
 * "Mixed practice" to the rest — a schedule you cannot navigate, because it says what kind of
 * question is on a day and nothing about what the day is about.
 */
describe("day focus", () => {
  const REAL_REQUIREMENTS: Requirement[] = [
    { id: "r1", text: "Orchestration UX — sub-agent state, streaming partial output, interrupts", kind: "technical", priority: "must" },
    { id: "r2", text: "Connected services: Gmail, Drive and Slack", kind: "technical", priority: "must" },
    { id: "r3", text: "5+ years building production services in Python", kind: "technical", priority: "must" },
    { id: "r4", text: "Mentoring junior engineers and reviewing their work", kind: "behavioural", priority: "must" },
    { id: "r5", text: "A background in payments or another regulated domain", kind: "domain", priority: "nice" },
  ];

  const oneQuestionPer = (): InternalQuestion[] =>
    REAL_REQUIREMENTS.map((r, index) =>
      question({ id: `q${index + 1}`, requirementIds: [r.id], difficulty: 2, order: index }),
    );

  const scheduleOf = (days: number) =>
    allocateSchedule({ questions: oneQuestionPer(), requirements: REAL_REQUIREMENTS, daysAvailable: days });

  it("names the subject rather than the category", () => {
    const focuses = scheduleOf(5).days.map((d) => d.focus);

    expect(focuses).not.toContain("Mixed practice");
    expect(focuses).not.toContain("Technical depth");
    expect(focuses.join(" | ")).toContain("Orchestration UX");
  });

  it("strips the qualification and keeps the subject", () => {
    expect(subjectOf("5+ years building production services in Python")).toBe("Production services in Python");
    expect(subjectOf("Experience operating PostgreSQL at scale")).toBe("PostgreSQL at scale");
    expect(subjectOf("Orchestration UX — sub-agent state, streaming partial output")).toBe("Orchestration UX");
    expect(subjectOf("Ability to scope an ambiguous spec")).toBe("Scope an ambiguous spec");
  });

  it.each([3, 5, 7])("gives no two days the same focus unless they share requirements (%s days)", (days) => {
    const schedule = scheduleOf(days);
    const byId = new Map(oneQuestionPer().map((q) => [q.id, q]));

    const requirementsOn = (dayIndex: number): string =>
      [
        ...new Set(
          (schedule.days[dayIndex]?.questionIds ?? []).flatMap((id) => byId.get(id)?.requirementIds ?? []),
        ),
      ]
        .sort()
        .join(",");

    for (let a = 0; a < schedule.days.length; a += 1) {
      for (let b = a + 1; b < schedule.days.length; b += 1) {
        if (schedule.days[a]?.focus !== schedule.days[b]?.focus) continue;
        expect(
          requirementsOn(a),
          `day ${a + 1} and day ${b + 1} share the focus "${schedule.days[a]?.focus}" without sharing requirements`,
        ).toBe(requirementsOn(b));
      }
    }
  });

  it("keeps the review prefix on a repeated day", () => {
    const schedule = scheduleOf(12);
    const review = schedule.days.filter((d) => d.focus.startsWith("Review — "));

    expect(review.length).toBeGreaterThan(0);
    for (const day of review) expect(day.focus.length).toBeGreaterThan("Review — ".length);
  });

  it("still says something honest when there are no questions at all", () => {
    const schedule = allocateSchedule({ questions: [], requirements: [], daysAvailable: 2 });
    for (const day of schedule.days) expect(day.focus).toBe(EMPTY_DAY_FOCUS);
  });

  it("falls back to the question's own words when it covers no requirement", () => {
    const orphan = question({ id: "q1", requirementIds: [], prompt: "Why does agent observability matter here?" });
    const schedule = allocateSchedule({ questions: [orphan], requirements: [], daysAvailable: 1 });

    expect(schedule.days[0]?.focus).toContain("agent observability");
  });
});
