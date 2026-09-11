import { beforeEach, describe, expect, it } from "vitest";
import {
  addFlashcard,
  addManualQuestion,
  addQuestion,
  archiveQuestion,
  deleteQuestion,
  editBrief,
  editFlashcard,
  editQuestion,
  editScheduleDay,
  moveQuestion,
  pinQuestion,
  regenerateCategory,
  reorderQuestions,
  setQuestionPinned,
} from "../src/edits";
import { VersionConflictError } from "../src/version";

/**
 * Ids for the tests, local on purpose.
 *
 * `@trao/kernel` has a real one, but kernel is not on this package's tsconfig allowlist and a
 * test is not a good enough reason to widen the dependency rule. Four lines here keeps the
 * boundary exactly where it was.
 */
class TestIds {
  #n = 0;
  next(prefix: string): string {
    this.#n += 1;
    // Offset so a generated id cannot collide with a fixture's `q1`/`f1`.
    return `${prefix}${100 + this.#n}`;
  }
}
import { getKitForBuilder } from "../src/projections";
import { makeFlashcard, makeKit, makeQuestion, resetIds } from "./fixtures";

beforeEach(resetIds);

/**
 * The rule under every test here: a regeneration may only take back what the machine put there
 * and the user has not claimed.
 */
describe("regenerateCategory", () => {
  const fourKinds = () =>
    makeKit({
      questions: [
        makeQuestion({ id: "gen", category: "technical", origin: "generated", pinned: false, order: 0 }),
        makeQuestion({ id: "edited", category: "technical", origin: "edited", order: 1 }),
        makeQuestion({ id: "manual", category: "technical", origin: "manual", order: 2 }),
        makeQuestion({ id: "pinned", category: "technical", origin: "generated", pinned: true, order: 3 }),
        makeQuestion({ id: "other", category: "behavioural", origin: "generated", order: 4 }),
      ],
      schedule: { daysAvailable: 1, days: [{ day: 1, focus: "", questionIds: [], minutes: 0, edited: false }] },
    });

  it("drops only unpinned generated questions in the target category", () => {
    const kit = regenerateCategory(fourKinds(), "technical", []);
    const live = getKitForBuilder(kit).questions.map((q) => q.id);

    expect(live).toContain("edited");
    expect(live).toContain("manual");
    expect(live).toContain("pinned");
    expect(live).not.toContain("gen");
  });

  it("leaves other categories completely alone", () => {
    const kit = regenerateCategory(fourKinds(), "technical", []);
    expect(getKitForBuilder(kit).questions.map((q) => q.id)).toContain("other");
  });

  it("adds the replacements as generated and active", () => {
    const kit = regenerateCategory(fourKinds(), "technical", [
      { id: "new1", prompt: "New?", answerOutline: "Outline.", difficulty: 2, requirementIds: ["r1"] },
    ]);

    const added = kit.questions.find((q) => q.id === "new1");
    expect(added).toMatchObject({ origin: "generated", active: true, pinned: false, category: "technical" });
  });

  it("orders replacements after the survivors rather than on top of them", () => {
    const kit = regenerateCategory(fourKinds(), "technical", [
      { id: "new1", prompt: "New?", answerOutline: "Outline.", difficulty: 2, requirementIds: ["r1"] },
    ]);

    const technical = getKitForBuilder(kit).questions.filter((q) => q.category === "technical");
    expect(technical.map((q) => q.id)).toEqual(["edited", "manual", "pinned", "new1"]);
  });

  it("marks a coverage fallback question as fallback, not generated", () => {
    const kit = regenerateCategory(makeKit(), "technical", [
      {
        id: "fb1",
        prompt: "The role requires Five years of Python. Walk through your experience with it.",
        answerOutline: "",
        difficulty: 2,
        requirementIds: ["r1"],
        origin: "fallback",
      },
    ]);

    expect(kit.questions.find((q) => q.id === "fb1")?.origin).toBe("fallback");
  });

  it("archives a derived flashcard along with its question", () => {
    const kit = makeKit({
      questions: [makeQuestion({ id: "q1", category: "technical", origin: "generated", order: 0 })],
      flashcards: [makeFlashcard({ id: "f1", questionId: "q1", origin: "generated", order: 0 })],
      schedule: { daysAvailable: 1, days: [{ day: 1, focus: "", questionIds: ["q1"], minutes: 30, edited: false }] },
    });

    const regenerated = regenerateCategory(kit, "technical", []);
    expect(getKitForBuilder(regenerated).flashcards).toEqual([]);
  });

  it("keeps a flashcard the user edited even when its source question is regenerated away", () => {
    const kit = makeKit({
      questions: [makeQuestion({ id: "q1", category: "technical", origin: "generated", order: 0 })],
      flashcards: [makeFlashcard({ id: "f1", questionId: "q1", origin: "edited", order: 0 })],
      schedule: { daysAvailable: 1, days: [{ day: 1, focus: "", questionIds: ["q1"], minutes: 30, edited: false }] },
    });

    const regenerated = regenerateCategory(kit, "technical", []);
    expect(getKitForBuilder(regenerated).flashcards.map((f) => f.id)).toEqual(["f1"]);
  });

  it("never removes anything from storage, so no id can be reused", () => {
    const kit = regenerateCategory(fourKinds(), "technical", []);
    expect(kit.questions.map((q) => q.id)).toContain("gen");
    expect(kit.questions.find((q) => q.id === "gen")?.active).toBe(false);
  });
});

describe("editQuestion", () => {
  it("promotes a generated question to edited, so a regeneration cannot take it", () => {
    const kit = editQuestion(makeKit(), "q1", { prompt: "Rewritten." });
    const question = kit.questions.find((q) => q.id === "q1");

    expect(question?.origin).toBe("edited");
    expect(question?.prompt).toBe("Rewritten.");
  });

  it("does not pin — changing something and wanting it kept are different intents", () => {
    const kit = editQuestion(makeKit(), "q1", { prompt: "Rewritten." });
    expect(kit.questions.find((q) => q.id === "q1")?.pinned).toBe(false);
  });

  it("leaves a manual question manual", () => {
    let kit = addManualQuestion(makeKit(), "technical", {
      id: "m1",
      prompt: "Mine.",
      answerOutline: "",
      difficulty: 1,
      requirementIds: [],
    });
    kit = editQuestion(kit, "m1", { prompt: "Mine, revised." });

    expect(kit.questions.find((q) => q.id === "m1")?.origin).toBe("manual");
  });

  it("promotes a fallback question to edited too", () => {
    const kit = makeKit({
      questions: [makeQuestion({ id: "fb1", origin: "fallback", order: 0 })],
      schedule: { daysAvailable: 1, days: [{ day: 1, focus: "", questionIds: ["fb1"], minutes: 20, edited: false }] },
    });

    expect(editQuestion(kit, "fb1", { prompt: "Better." }).questions[0]?.origin).toBe("edited");
  });

  it("survives a regeneration of its own category", () => {
    let kit = editQuestion(makeKit(), "q1", { prompt: "Rewritten." });
    kit = regenerateCategory(kit, "technical", []);

    expect(getKitForBuilder(kit).questions.map((q) => q.id)).toContain("q1");
  });
});

describe("editFlashcard", () => {
  it("promotes to edited", () => {
    const kit = editFlashcard(makeKit(), "f1", { front: "Rewritten?" });
    expect(kit.flashcards.find((f) => f.id === "f1")).toMatchObject({ origin: "edited", front: "Rewritten?" });
  });
});

describe("setQuestionPinned", () => {
  it("keeps a generated question through a regeneration once pinned", () => {
    let kit = setQuestionPinned(makeKit(), "q1", true);
    kit = regenerateCategory(kit, "technical", []);

    expect(getKitForBuilder(kit).questions.map((q) => q.id)).toContain("q1");
  });

  it("is reversible", () => {
    let kit = setQuestionPinned(makeKit(), "q1", true);
    kit = setQuestionPinned(kit, "q1", false);
    kit = regenerateCategory(kit, "technical", []);

    expect(getKitForBuilder(kit).questions.map((q) => q.id)).not.toContain("q1");
  });
});

describe("addManualQuestion", () => {
  it("marks it manual and survives regeneration", () => {
    let kit = addManualQuestion(makeKit(), "technical", {
      id: "m1",
      prompt: "Mine.",
      answerOutline: "",
      difficulty: 1,
      requirementIds: ["r1"],
    });
    kit = regenerateCategory(kit, "technical", []);

    const question = getKitForBuilder(kit).questions.find((q) => q.id === "m1");
    expect(question).toMatchObject({ origin: "manual", active: true });
  });
});

describe("archiveQuestion", () => {
  it("hides the question and its derived flashcard from the builder", () => {
    const builder = getKitForBuilder(archiveQuestion(makeKit(), "q1"));

    expect(builder.questions.map((q) => q.id)).not.toContain("q1");
    expect(builder.flashcards.map((f) => f.id)).not.toContain("f1");
  });

  it("takes an edited card with it rather than leaving an orphan", () => {
    // Changed deliberately, and it is the one place delete and regenerate disagree. A
    // regeneration is the machine taking back its own work, so it spares anything the user
    // claimed — `regenerateCategory` still does. Deleting the question outright is the user
    // removing the thing the card quizzes them on, and a card left pointing at a question that
    // is gone is an orphan on screen with no way to reach its source.
    const kit = makeKit({
      flashcards: [
        makeFlashcard({ id: "f1", questionId: "q1", origin: "edited", order: 0 }),
        makeFlashcard({ id: "f2", questionId: null, origin: "manual", order: 1 }),
      ],
    });

    const builder = getKitForBuilder(deleteQuestion(kit, "q1"));
    expect(builder.flashcards.map((f) => f.id)).toEqual(["f2"]);
  });
});

// ── versioning and the mutations the builder added ───────────────────────────────────────

describe("version", () => {
  it("bumps by exactly one per mutation", () => {
    const kit = makeKit({ version: 7 });
    const once = editQuestion(kit, kit.questions[0]!.id, { prompt: "one" });
    const twice = editQuestion(once, once.questions[0]!.id, { prompt: "two" });

    expect(once.version).toBe(8);
    expect(twice.version).toBe(9);
    // Pure: the kit handed in is never mutated, so a caller holding the old one still has it.
    expect(kit.version).toBe(7);
  });

  it("accepts a matching ifVersion", () => {
    const kit = makeKit({ version: 7 });
    expect(editQuestion(kit, kit.questions[0]!.id, { prompt: "ok" }, { ifVersion: 7 }).version).toBe(8);
  });

  it("refuses a stale write and says what the version actually is", () => {
    const kit = makeKit({ version: 8 });
    try {
      editQuestion(kit, kit.questions[0]!.id, { prompt: "from a stale tab" }, { ifVersion: 7 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(VersionConflictError);
      expect((error as VersionConflictError).code).toBe("VERSION_CONFLICT");
      expect((error as VersionConflictError).currentVersion).toBe(8);
      expect((error as VersionConflictError).expectedVersion).toBe(7);
    }
  });

  it("leaves the kit untouched when it refuses", () => {
    const kit = makeKit({ version: 8 });
    const before = JSON.stringify(kit);
    expect(() => editQuestion(kit, kit.questions[0]!.id, { prompt: "no" }, { ifVersion: 1 })).toThrow();
    expect(JSON.stringify(kit)).toBe(before);
  });
});

describe("deleteQuestion", () => {
  it("archives the question and every card derived from it, whatever their origin", () => {
    const kit = makeKit({
      questions: [makeQuestion({ id: "q1" })],
      flashcards: [
        makeFlashcard({ id: "f1", questionId: "q1", origin: "generated" }),
        makeFlashcard({ id: "f2", questionId: "q1", origin: "edited" }),
        makeFlashcard({ id: "f3", questionId: "q1", origin: "manual", pinned: true }),
        makeFlashcard({ id: "f4", questionId: null }),
      ],
    });

    const after = deleteQuestion(kit, "q1");

    expect(after.questions.find((q) => q.id === "q1")?.active).toBe(false);
    // A card whose question is gone has nothing behind it — pinning cannot keep an orphan.
    for (const id of ["f1", "f2", "f3"]) {
      expect(after.flashcards.find((f) => f.id === id)?.active, id).toBe(false);
    }
    expect(after.flashcards.find((f) => f.id === "f4")?.active).toBe(true);
  });

  it("never removes the record, so the id can never be reused", () => {
    const kit = makeKit({ questions: [makeQuestion({ id: "q1" })] });
    const after = deleteQuestion(kit, "q1");
    expect(after.questions).toHaveLength(1);
    expect(after.questions[0]!.id).toBe("q1");
  });
});

describe("editQuestion", () => {
  it("promotes generated to edited but leaves manual alone", () => {
    const kit = makeKit({
      questions: [
        makeQuestion({ id: "q1", origin: "generated" }),
        makeQuestion({ id: "q2", origin: "manual" }),
      ],
    });
    const after = editQuestion(editQuestion(kit, "q1", { prompt: "a" }), "q2", { prompt: "b" });
    expect(after.questions.find((q) => q.id === "q1")?.origin).toBe("edited");
    expect(after.questions.find((q) => q.id === "q2")?.origin).toBe("manual");
  });

  it("does not pin, because changing a thing is not the same as keeping it", () => {
    const kit = makeKit({ questions: [makeQuestion({ id: "q1", pinned: false })] });
    expect(editQuestion(kit, "q1", { prompt: "x" }).questions[0]!.pinned).toBe(false);
  });
});

describe("pinQuestion", () => {
  it("flips only the flag", () => {
    const kit = makeKit({ questions: [makeQuestion({ id: "q1", origin: "generated", pinned: false })] });
    const after = pinQuestion(kit, "q1", true);
    expect(after.questions[0]!.pinned).toBe(true);
    // Unchanged, so unpinning puts it back in reach of a regeneration.
    expect(after.questions[0]!.origin).toBe("generated");
  });
});

describe("moveQuestion", () => {
  it("moves the question, keeps its requirement ids, and lands it last", () => {
    const kit = makeKit({
      questions: [
        makeQuestion({ id: "q1", category: "technical", requirementIds: ["r1", "r2"], origin: "generated" }),
        makeQuestion({ id: "q2", category: "behavioural", order: 0 }),
        makeQuestion({ id: "q3", category: "behavioural", order: 1 }),
      ],
    });

    const moved = moveQuestion(kit, "q1", "behavioural").questions.find((q) => q.id === "q1")!;
    expect(moved.category).toBe("behavioural");
    // Coverage is computed from these, so a move must not change what the question covers.
    expect(moved.requirementIds).toEqual(["r1", "r2"]);
    expect(moved.order).toBe(2);
    expect(moved.origin).toBe("edited");
  });
});

describe("reorderQuestions", () => {
  it("orders the listed ids and leaves the rest after them in their old order", () => {
    const kit = makeKit({
      questions: [
        makeQuestion({ id: "q1", category: "technical", order: 0 }),
        makeQuestion({ id: "q2", category: "technical", order: 1 }),
        makeQuestion({ id: "q3", category: "technical", order: 2 }),
        makeQuestion({ id: "q4", category: "technical", order: 3 }),
      ],
    });

    const after = reorderQuestions(kit, "technical", ["q3", "q1"]);
    const order = after.questions
      .filter((q) => q.category === "technical")
      .sort((a, b) => a.order - b.order)
      .map((q) => q.id);

    // Listed first in the order given; unlisted keep their relative order behind them.
    expect(order).toEqual(["q3", "q1", "q2", "q4"]);
  });

  it("ignores ids that are not in the category", () => {
    const kit = makeKit({
      questions: [
        makeQuestion({ id: "q1", category: "technical", order: 0 }),
        makeQuestion({ id: "q9", category: "behavioural", order: 0 }),
      ],
    });
    const after = reorderQuestions(kit, "technical", ["q9", "q1"]);
    expect(after.questions.find((q) => q.id === "q9")?.order).toBe(0);
    expect(after.questions.find((q) => q.id === "q1")?.order).toBe(0);
  });
});

describe("editScheduleDay", () => {
  it("marks the day edited so allocation steps around it", () => {
    const kit = makeKit();
    const after = editScheduleDay(kit, 1, { focus: "I renamed this day" });
    const day = after.schedule.days.find((d) => d.day === 1)!;
    expect(day.focus).toBe("I renamed this day");
    expect(day.edited).toBe(true);
    expect(after.schedule.days.filter((d) => d.day !== 1).every((d) => !d.edited)).toBe(true);
  });
});

describe("editBrief", () => {
  it("claims the brief for the user", () => {
    const kit = makeKit();
    const after = editBrief(kit, { summary: "mine now" });
    expect(after.companyBrief.summary).toBe("mine now");
    expect(after.companyBrief.origin).toBe("edited");
  });
});

describe("addQuestion", () => {
  it("takes fresh ids, marks both manual, and derives a card from the question", () => {
    const kit = makeKit({ questions: [makeQuestion({ id: "q1", category: "behavioural", order: 0 })], flashcards: [] });
    const ids = new TestIds();

    const after = addQuestion(
      kit,
      { category: "behavioural", prompt: "My own question.", answerOutline: "mine", difficulty: 2, requirementIds: ["r3"] },
      ids,
    );

    const added = after.questions.find((q) => q.id !== "q1")!;
    expect(added.origin).toBe("manual");
    expect(added.order).toBe(1);
    expect(added.requirementIds).toEqual(["r3"]);

    expect(after.flashcards).toHaveLength(1);
    const card = after.flashcards[0]!;
    expect(card.questionId).toBe(added.id);
    // Manual, so a regeneration of the category cannot sweep the pair up.
    expect(card.origin).toBe("manual");
    expect(card.id).not.toBe(added.id);
  });
});

describe("addFlashcard", () => {
  it("stands on its own with nothing behind it", () => {
    const kit = makeKit({ flashcards: [] });
    const after = addFlashcard(kit, { front: "f", back: "b" }, new TestIds());
    expect(after.flashcards[0]!.questionId).toBeNull();
    expect(after.flashcards[0]!.origin).toBe("manual");
  });
});
