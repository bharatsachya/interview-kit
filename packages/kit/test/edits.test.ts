import { beforeEach, describe, expect, it } from "vitest";
import {
  addManualQuestion,
  archiveQuestion,
  editFlashcard,
  editQuestion,
  regenerateCategory,
  setQuestionPinned,
} from "../src/edits";
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

  it("keeps a flashcard the user made their own", () => {
    const kit = makeKit({
      flashcards: [makeFlashcard({ id: "f1", questionId: "q1", origin: "edited", order: 0 })],
    });

    expect(getKitForBuilder(archiveQuestion(kit, "q1")).flashcards.map((f) => f.id)).toEqual(["f1"]);
  });
});
