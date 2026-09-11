import { describe, expect, it } from "vitest";
import type { IdGenerator, LlmRequest } from "@trao/contracts";
import {
  VersionConflictError,
  editQuestion,
  toKitJSON,
  type InternalFlashcard,
  type InternalKit,
  type InternalQuestion,
} from "@trao/kit";
import { regenerateSection } from "../src/regenerate";
import { StubLlm, TestTracer } from "./doubles";

/**
 * Regenerating one section of a kit somebody has been editing.
 *
 * The eval suite (`evals/steps/13-builder-regeneration`) covers the provenance matrix case by
 * case. What is here is the behaviour underneath it that no single case isolates: that a call
 * bumps the version exactly once however many steps run inside it, that a stale `ifVersion` is
 * refused before anything is generated, and that the two branches which are supposed to touch
 * nothing actually touch nothing.
 */

let counter = 0;
const ids: IdGenerator = { next: (prefix) => `${prefix}gen${(counter += 1)}` };

function question(overrides: Partial<InternalQuestion> = {}): InternalQuestion {
  return {
    id: "q1",
    category: "technical",
    prompt: "Walk through a Postgres query you tuned.",
    answerOutline: "EXPLAIN, the index, the result.",
    difficulty: 2,
    requirementIds: ["r1"],
    origin: "generated",
    pinned: false,
    active: true,
    order: 0,
    ...overrides,
  };
}

function card(overrides: Partial<InternalFlashcard> = {}): InternalFlashcard {
  return {
    id: "f1",
    front: "Walk through a Postgres query you tuned.",
    back: "EXPLAIN, the index, the result.",
    requirementIds: ["r1"],
    questionId: "q1",
    origin: "generated",
    pinned: false,
    active: true,
    order: 0,
    ...overrides,
  };
}

function kit(overrides: Partial<InternalKit> = {}): InternalKit {
  return {
    id: "kit_1",
    createdAt: 0,
    version: 7,
    role: {
      title: "Senior Backend Engineer",
      company: "Northwind",
      location: "Berlin",
      summary: "senior",
      responsibilities: ["Own routing services"],
    },
    companyBrief: {
      summary: "Northwind builds routing software.",
      whatTheyDo: "Routing software.",
      hiringProcess: "Take-home, then a design round.",
      sources: ["https://northwind.example/", "https://forum.example/northwind"],
      pagesUsed: ["https://northwind.example/"],
      passages: [{ url: "https://northwind.example/", title: "Northwind", text: "We route parcels." }],
      gaps: ["No page describing the interview process was found on the company site."],
      origin: "generated",
      edited: false,
    },
    requirements: [
      { id: "r1", text: "PostgreSQL query tuning", kind: "technical", priority: "must", sourceSpan: "PostgreSQL, including query tuning" },
      { id: "r2", text: "written communication", kind: "behavioural", priority: "must", sourceSpan: "Strong written communication" },
    ],
    questions: [
      question(),
      question({ id: "q2", category: "behavioural", requirementIds: ["r2"], prompt: "Describe an RFC you wrote.", order: 0 }),
    ],
    flashcards: [card(), card({ id: "f2", questionId: "q2", front: "Describe an RFC you wrote.", order: 1 })],
    schedule: {
      daysAvailable: 2,
      days: [
        { day: 1, focus: "Postgres", questionIds: ["q1"], minutes: 30, edited: false },
        { day: 2, focus: "I renamed this day", questionIds: ["q2"], minutes: 30, edited: true },
      ],
    },
    coverage: { passes: 1, uncoveredRequirementIds: [] },
    ...overrides,
  };
}

const QUESTIONS = (prompt: string, requirementIds: string[] = []) => ({
  questions: [{ prompt, answer_outline: "Three points.", difficulty: 2, requirement_ids: requirementIds }],
});

function deps(responses: Record<string, (r: LlmRequest<unknown>) => unknown>) {
  const tracer = new TestTracer();
  const llm = new StubLlm(responses).tracing(tracer);
  return { llm, tracer, ids, deps: { llm, ids, tracer } };
}

describe("regenerateSection", () => {
  describe("versioning", () => {
    it("bumps the version exactly once, however many steps run inside", async () => {
      const d = deps({
        generate_questions: () => QUESTIONS("A fresh question about PostgreSQL query tuning.", ["r1"]),
        gap_fill: () => ({ prompt: "x", answer_outline: "", difficulty: 2 }),
      });

      const next = await regenerateSection(kit(), { section: "questions", category: "technical" }, d.deps);

      // Archive, generate, coverage, gap fill and flashcards all happened under one commit.
      expect(next.version).toBe(8);
    });

    it("refuses a stale write before generating anything", async () => {
      const d = deps({ generate_questions: () => QUESTIONS("Never asked for.") });

      await expect(
        regenerateSection(kit(), { section: "questions", category: "technical" }, { ...d.deps, ifVersion: 6 }),
      ).rejects.toBeInstanceOf(VersionConflictError);
    });

    it("carries the version the kit is actually on, so the caller can rebase", async () => {
      const d = deps({ generate_brief: () => ({ summary: "s", what_they_do: "w", hiring_process: "" }) });

      const error: unknown = await regenerateSection(
        kit(),
        { section: "company_brief" },
        { ...d.deps, ifVersion: 3 },
      ).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(VersionConflictError);
      expect((error as VersionConflictError).currentVersion).toBe(7);
      expect((error as VersionConflictError).expectedVersion).toBe(3);
    });
  });

  describe("ids", () => {
    /** What a composition root that builds one generator per job actually hands over. */
    function freshSequentialIds(): IdGenerator {
      const counters = new Map<string, number>();
      return {
        next: (prefix) => {
          const n = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, n);
          return `${prefix}${n}`;
        },
      };
    }

    it("never hands a new question an id the kit already holds", async () => {
      const tracer = new TestTracer();
      const llm = new StubLlm({
        generate_questions: () => QUESTIONS("A new PostgreSQL query tuning question.", ["r1"]),
        gap_fill: () => ({ prompt: "x", answer_outline: "", difficulty: 2 }),
      }).tracing(tracer);

      // The kit's first question is already `q1`, and this generator starts counting at q1.
      const next = await regenerateSection(
        kit(),
        { section: "questions", category: "technical" },
        { llm, ids: freshSequentialIds(), tracer },
      );

      const seen = next.questions.map((q) => q.id);
      expect(seen.filter((id, i) => seen.indexOf(id) !== i)).toEqual([]);
      // The archived original still resolves to itself, rather than to whatever came last.
      expect(next.questions.filter((q) => q.id === "q1")).toHaveLength(1);
    });

    it("does not reuse a flashcard id either", async () => {
      const tracer = new TestTracer();
      const llm = new StubLlm({
        generate_questions: () => QUESTIONS("A new PostgreSQL query tuning question.", ["r1"]),
        gap_fill: () => ({ prompt: "x", answer_outline: "", difficulty: 2 }),
      }).tracing(tracer);

      const next = await regenerateSection(
        kit(),
        { section: "questions", category: "technical" },
        { llm, ids: freshSequentialIds(), tracer },
      );

      const seen = next.flashcards.map((f) => f.id);
      expect(seen.filter((id, i) => seen.indexOf(id) !== i)).toEqual([]);
    });

    it("says on the span when the caller's generator was colliding", async () => {
      const tracer = new TestTracer();
      const llm = new StubLlm({
        generate_questions: () => QUESTIONS("A new PostgreSQL query tuning question.", ["r1"]),
        gap_fill: () => ({ prompt: "x", answer_outline: "", difficulty: 2 }),
      }).tracing(tracer);

      await regenerateSection(
        kit(),
        { section: "questions", category: "technical" },
        { llm, ids: freshSequentialIds(), tracer },
      );

      // Silently correct is not good enough: the misconfiguration has to be visible somewhere.
      expect(tracer.byStep("regenerate_section")?.attrs["ids_skipped"]).toBeGreaterThan(0);
    });

    it("leaves a correctly wired caller's ids alone", async () => {
      const d = deps({
        generate_questions: () => QUESTIONS("A new PostgreSQL query tuning question.", ["r1"]),
        gap_fill: () => ({ prompt: "x", answer_outline: "", difficulty: 2 }),
      });

      await regenerateSection(kit(), { section: "questions", category: "technical" }, d.deps);

      expect(d.tracer.byStep("regenerate_section")?.attrs["ids_skipped"]).toBeUndefined();
    });
  });

  describe("the schedule branch", () => {
    it("calls no model at all", async () => {
      const d = deps({});
      await regenerateSection(kit(), { section: "schedule" }, d.deps);
      expect(d.llm.calls).toEqual([]);
    });

    it("returns an edited day byte-for-byte", async () => {
      const before = kit();
      const d = deps({});

      const next = await regenerateSection(before, { section: "schedule" }, d.deps);

      expect(next.schedule.days[1]).toEqual(before.schedule.days[1]);
    });

    it("leaves every question and flashcard alone", async () => {
      const before = kit();
      const d = deps({});

      const next = await regenerateSection(before, { section: "schedule" }, d.deps);

      expect(next.questions).toEqual(before.questions);
      expect(next.flashcards).toEqual(before.flashcards);
    });
  });

  describe("the brief branch", () => {
    const brief = {
      generate_brief: () => ({ summary: "Rewritten.", what_they_do: "Routing.", hiring_process: "Two rounds." }),
    };

    it("replaces the prose and nothing else", async () => {
      const before = kit();
      const d = deps(brief);

      const next = await regenerateSection(before, { section: "company_brief" }, d.deps);

      expect(next.companyBrief.summary).toBe("Rewritten.");
      expect(next.questions).toEqual(before.questions);
      expect(next.flashcards).toEqual(before.flashcards);
      expect(next.schedule).toEqual(before.schedule);
      expect(next.role).toEqual(before.role);
      expect(d.llm.calls).toHaveLength(1);
    });

    it("keeps the record of what was retrieved, because nothing was retrieved", async () => {
      const before = kit();
      const d = deps(brief);

      const next = await regenerateSection(before, { section: "company_brief" }, d.deps);

      // `sources` includes a discussion URL the regeneration never saw. Recomputing these from
      // the inputs to THIS call would quietly drop it and claim the kit was built from less than
      // it was.
      expect(next.companyBrief.sources).toEqual(before.companyBrief.sources);
      expect(next.companyBrief.pagesUsed).toEqual(before.companyBrief.pagesUsed);
      expect(next.companyBrief.gaps).toEqual(before.companyBrief.gaps);
    });

    it("prompts with the stored passages, not a list of bare URLs", async () => {
      const d = deps(brief);

      await regenerateSection(kit(), { section: "company_brief" }, d.deps);

      expect(d.llm.calls[0]?.prompt).toContain("We route parcels.");
    });
  });

  describe("the questions branch", () => {
    it("takes back only unpinned generated questions in that category", async () => {
      const before = kit({
        questions: [
          question({ id: "q1" }),
          question({ id: "q2", pinned: true, order: 1 }),
          question({ id: "q3", origin: "edited", order: 2 }),
          question({ id: "q4", origin: "manual", order: 3 }),
          question({ id: "q5", category: "behavioural", requirementIds: ["r2"], order: 0 }),
        ],
        flashcards: [],
      });
      const d = deps({
        generate_questions: () => QUESTIONS("Another PostgreSQL query tuning question.", ["r1"]),
        gap_fill: () => ({ prompt: "Describe written communication in an RFC.", answer_outline: "", difficulty: 2 }),
      });

      const next = await regenerateSection(before, { section: "questions", category: "technical" }, d.deps);

      const active = (id: string) => next.questions.find((q) => q.id === id)?.active;
      expect(active("q1")).toBe(false);
      expect([active("q2"), active("q3"), active("q4"), active("q5")]).toEqual([true, true, true, true]);
    });

    it("never writes to the schedule — repair does that at the serialize boundary", async () => {
      const before = kit();
      const d = deps({
        generate_questions: () => QUESTIONS("A new PostgreSQL query tuning question.", ["r1"]),
        gap_fill: () => ({ prompt: "x", answer_outline: "", difficulty: 2 }),
      });

      const next = await regenerateSection(before, { section: "questions", category: "technical" }, d.deps);

      // The archived question is still listed on day 1 internally …
      expect(next.schedule).toEqual(before.schedule);
      // … and gone the moment the kit is projected.
      const days = toKitJSON(next).schedule.days;
      expect(days.flatMap((d2) => d2.question_ids)).not.toContain("q1");
    });

    it("asks only about requirements the survivors no longer cover", async () => {
      const before = kit({
        questions: [
          question({ id: "q1", requirementIds: ["r1"] }),
          question({ id: "q2", requirementIds: ["r1"], origin: "edited", order: 1 }),
          question({ id: "q3", category: "behavioural", requirementIds: ["r2"], order: 0 }),
        ],
        requirements: [
          ...kit().requirements,
          { id: "r3", text: "Kubernetes operators", kind: "technical", priority: "must", sourceSpan: "Kubernetes operators" },
        ],
        flashcards: [],
      });
      const d = deps({
        generate_questions: () => QUESTIONS("A Kubernetes operators question.", ["r3"]),
        gap_fill: () => ({ prompt: "x", answer_outline: "", difficulty: 2 }),
      });

      await regenerateSection(before, { section: "questions", category: "technical" }, d.deps);

      // r1 survives on the edited q2, so the call is about r3 alone.
      const prompt = d.llm.calls[0]?.prompt ?? "";
      expect(prompt).toContain("r3");
      expect(prompt).not.toContain("- r1 ");
    });

    it("does not let a one-requirement seed label the question that comes back", async () => {
      const before = kit({
        questions: [question({ id: "q1" }), question({ id: "q2", category: "behavioural", requirementIds: ["r2"], order: 0 })],
        flashcards: [],
      });
      const d = deps({
        // Seeded with r1, the model answers about something else and tags nothing. Believing the
        // seed here would close r1 on the strength of having asked about it.
        generate_questions: () => QUESTIONS("An unrelated question about team rituals."),
        gap_fill: () => ({ prompt: "A PostgreSQL query tuning question.", answer_outline: "", difficulty: 2 }),
      });

      const next = await regenerateSection(before, { section: "questions", category: "technical" }, d.deps);

      const generated = next.questions.find((q) => q.prompt === "An unrelated question about team rituals.");
      expect(generated?.requirementIds).toEqual([]);
      // Coverage noticed and filled it, with ids the code attached.
      expect(next.questions.some((q) => q.active && q.requirementIds.includes("r1") && q.id !== "q1")).toBe(true);
    });

    it("mints cards for the new questions only, so practice history survives", async () => {
      const before = kit();
      const d = deps({
        generate_questions: () => QUESTIONS("A new PostgreSQL query tuning question.", ["r1"]),
        gap_fill: () => ({ prompt: "x", answer_outline: "", difficulty: 2 }),
      });

      const next = await regenerateSection(before, { section: "questions", category: "technical" }, d.deps);

      // f2 belongs to the untouched behavioural question and keeps its id.
      expect(next.flashcards.find((f) => f.id === "f2")).toEqual(before.flashcards[1]);
      expect(next.flashcards.filter((f) => f.active).some((f) => f.front.includes("new PostgreSQL"))).toBe(true);
    });

    it("records the steps in the order they happened", async () => {
      const before = kit({
        questions: [question({ id: "q1" }), question({ id: "q2", category: "behavioural", requirementIds: ["r2"], order: 0 })],
        flashcards: [],
      });
      const d = deps({
        generate_questions: () => QUESTIONS("Nothing about the requirement."),
        gap_fill: () => ({ prompt: "A PostgreSQL query tuning question.", answer_outline: "", difficulty: 2 }),
      });

      await regenerateSection(before, { section: "questions", category: "technical" }, d.deps);

      const steps = d.tracer.spans.map((s) => s.step);
      expect(steps[0]).toBe("regenerate_section");
      const at = (prefix: string) => steps.findIndex((s) => s.startsWith(prefix));
      expect(at("category:technical")).toBeGreaterThan(-1);
      expect(at("coverage_check")).toBeGreaterThan(at("category:technical"));
      expect(at("gap_fill ")).toBeGreaterThan(at("coverage_check"));
    });

    it("refuses to guess a category", async () => {
      const d = deps({});
      await expect(regenerateSection(kit(), { section: "questions" }, d.deps)).rejects.toThrow(/category/i);
    });
  });

  it("leaves an edit made by hand exactly as the user left it", async () => {
    const edited = editQuestion(kit(), "q1", { prompt: "I rewrote this myself." });
    const d = deps({
      generate_questions: () => QUESTIONS("A replacement PostgreSQL query tuning question.", ["r1"]),
      gap_fill: () => ({ prompt: "x", answer_outline: "", difficulty: 2 }),
    });

    const next = await regenerateSection(edited, { section: "questions", category: "technical" }, d.deps);

    const q1 = next.questions.find((q) => q.id === "q1");
    expect(q1).toEqual(edited.questions.find((q) => q.id === "q1"));
    expect(q1?.prompt).toBe("I rewrote this myself.");
  });
});
