import { describe, expect, it } from "vitest";
import type { InternalKit } from "@trao/kit";
import { outputText } from "../src/lib/kit-outputs";

const flags = { origin: "generated" as const, pinned: false, active: true };

const kit = (over: Partial<InternalKit> = {}): InternalKit => ({
  id: "kit_1",
  createdAt: 0,
  version: 1,
  role: {
    title: "Senior Backend Engineer",
    company: "Vaultline",
    location: "Berlin",
    summary: "Owns the ledger service.",
    responsibilities: ["Own the ledger service"],
  },
  companyBrief: {
    summary: "Vaultline builds payment infrastructure.",
    whatTheyDo: "Payouts for marketplaces.",
    hiringProcess: "",
    sources: ["https://vaultline.test/about"],
    pagesUsed: ["https://vaultline.test/about"],
    gaps: ["No page describing the interview process was found."],
    origin: "generated",
    edited: false,
  },
  requirements: [{ id: "r1", text: "PostgreSQL query tuning", kind: "technical", priority: "must" }],
  questions: [
    { ...flags, id: "q1", category: "technical", prompt: "Tune this query.", answerOutline: "Read the plan.", difficulty: 2, requirementIds: ["r1"], order: 0 },
    { ...flags, id: "q2", category: "behavioural", prompt: "Tell me about mentoring.", answerOutline: "One person, one outcome.", difficulty: 1, requirementIds: [], order: 0 },
  ],
  flashcards: [{ ...flags, id: "f1", front: "Query plans", back: "Read them.", requirementIds: ["r1"], questionId: "q1", order: 0 }],
  schedule: {
    daysAvailable: 2,
    days: [
      { day: 1, focus: "Postgres", questionIds: ["q1"], minutes: 30, edited: false },
      { day: 2, focus: "Review", questionIds: [], minutes: 0, edited: false },
    ],
  },
  coverage: { passes: 1, uncoveredRequirementIds: [] },
  ...over,
});

/**
 * What the panel's Copy button puts on the clipboard.
 *
 * The button rendered with no `onClick` for a while, so none of this was reachable. Now that it
 * is, the properties worth holding are the ones a projection always has: archived items stay
 * out, absent sections leave no empty heading, and provenance never reaches the clipboard.
 */
describe("outputText", () => {
  it("writes the brief with its gaps, not just its prose", () => {
    const text = outputText("brief", kit());
    expect(text).toContain("Vaultline builds payment infrastructure.");
    expect(text).toContain("Payouts for marketplaces.");
    // A brief pasted somewhere without its gaps reads as complete, and the difference between
    // those two is the thing this kit is careful about.
    expect(text).toContain("No page describing the interview process was found.");
  });

  it("leaves no heading behind for a section that is empty", () => {
    // `hiringProcess` is the empty string by design when nothing described it.
    expect(outputText("brief", kit())).not.toContain("HIRING PROCESS");
  });

  it("groups questions by category, with their outlines", () => {
    const text = outputText("questions", kit());
    expect(text).toContain("TECHNICAL");
    expect(text).toContain("Tune this query.");
    expect(text).toContain("Read the plan.");
    expect(text).toContain("BEHAVIOURAL");
  });

  it("omits a category nothing is in", () => {
    expect(outputText("questions", kit())).not.toContain("SYSTEM-DESIGN");
  });

  it("resolves the schedule's question ids to the questions themselves", () => {
    const text = outputText("schedule", kit());
    expect(text).toContain("Day 1 — Postgres (30 min)");
    // An id on a clipboard is useless; the point of pasting a plan is reading it.
    expect(text).toContain("Tune this query.");
    expect(text).not.toContain("q1");
  });

  it("hands over the deck for practice, which has no document of its own", () => {
    expect(outputText("practice", kit())).toBe(outputText("flashcards", kit()));
    expect(outputText("practice", kit())).toContain("Query plans");
  });

  it("never copies an archived item", () => {
    const archived = kit({
      questions: kit().questions.map((q) => ({ ...q, active: false })),
      flashcards: kit().flashcards.map((f) => ({ ...f, active: false })),
    });
    expect(outputText("questions", archived)).not.toContain("Tune this query.");
    expect(outputText("flashcards", archived)).not.toContain("Query plans");
  });

  it("never puts provenance on the clipboard", () => {
    for (const id of ["brief", "role", "questions", "flashcards", "schedule", "practice"] as const) {
      const text = outputText(id, kit());
      expect(text).not.toMatch(/origin|pinned|"active"/);
    }
  });

  it("names the role at the top of every output", () => {
    for (const id of ["brief", "role", "questions", "flashcards", "schedule"] as const) {
      expect(outputText(id, kit()).startsWith("Vaultline — Senior Backend Engineer")).toBe(true);
    }
  });
});
