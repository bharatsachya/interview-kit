import { beforeEach, describe, expect, it } from "vitest";
import { forkKit, lineageLabel } from "../src/fork";
import { editQuestion, pinQuestion } from "../src/edits";
import { toKitJSON } from "../src/projections";
import { makeKit, resetIds } from "./fixtures";

beforeEach(resetIds);

/**
 * Forking, which is what a rewrite does instead of overwriting.
 *
 * The property worth a test is not that the copy has a new id — it is that the original is
 * still the original afterwards. Everything else in the builder mutates in place, so this is the
 * one transition where "did not touch the input" has to be asserted rather than assumed.
 */
describe("forkKit", () => {
  const lineage = { fromKitId: "kit_1", section: "questions" as const, category: "technical" as const, at: 42 };

  it("leaves the kit it was given byte-identical", () => {
    const original = makeKit();
    const before = structuredClone(original);

    forkKit(original, { id: "kit_2", at: 42, from: lineage });

    expect(original).toEqual(before);
  });

  it("starts its own version count rather than inheriting one", () => {
    const original = makeKit({ version: 8 });

    const fork = forkKit(original, { id: "kit_2", at: 42, from: lineage });

    // Two documents both claiming version 8 is how an `If-Match` written against one of them
    // passes silently against the other.
    expect(fork.version).toBe(1);
    expect(fork.id).toBe("kit_2");
    expect(fork.createdAt).toBe(42);
  });

  it("counts how many rewrites deep it is, from an original that never said", () => {
    const first = forkKit(makeKit(), { id: "kit_2", at: 1, from: lineage });
    const second = forkKit(first, { id: "kit_3", at: 2, from: { ...lineage, fromKitId: "kit_2" } });

    expect(first.revision).toBe(2);
    expect(second.revision).toBe(3);
  });

  it("keeps every id inside the document, so nothing that pointed at something still points at nothing", () => {
    const original = makeKit();

    const fork = forkKit(original, { id: "kit_2", at: 42, from: lineage });

    expect(fork.questions.map((q) => q.id)).toEqual(original.questions.map((q) => q.id));
    expect(fork.flashcards.map((f) => f.id)).toEqual(original.flashcards.map((f) => f.id));
    expect(fork.schedule.days.flatMap((d) => d.questionIds)).toEqual(
      original.schedule.days.flatMap((d) => d.questionIds),
    );
  });

  it("carries the user's own work across", () => {
    const edited = pinQuestion(editQuestion(makeKit(), "q1", { prompt: "I wrote this." }), "q1", true);

    const fork = forkKit(edited, { id: "kit_2", at: 42, from: lineage });

    const q1 = fork.questions.find((q) => q.id === "q1");
    expect(q1?.prompt).toBe("I wrote this.");
    expect(q1?.pinned).toBe(true);
    expect(q1?.origin).toBe("edited");
  });

  it("keeps the lineage out of Appendix A", () => {
    const fork = forkKit(makeKit(), { id: "kit_2", at: 42, from: { ...lineage, instructions: "Harder." } });

    // Appendix A's field names are frozen, and `forked_from` is not one of them. The projection
    // builds every field by hand, which is what makes this true rather than lucky — but the
    // assertion is cheap and the day somebody spreads the internal kit into it is not.
    expect(JSON.stringify(toKitJSON(fork))).not.toContain("forked");
    expect(JSON.stringify(toKitJSON(fork))).not.toContain("Harder.");
  });
});

describe("lineageLabel", () => {
  it("names the one section that changed, in the past tense", () => {
    expect(lineageLabel({ fromKitId: "k", section: "company_brief", at: 0 })).toBe("Rewrote the brief");
    expect(lineageLabel({ fromKitId: "k", section: "schedule", at: 0 })).toBe("Rebuilt the schedule");
    expect(lineageLabel({ fromKitId: "k", section: "questions", category: "system-design", at: 0 })).toBe(
      "Rewrote the system-design questions",
    );
  });
});
