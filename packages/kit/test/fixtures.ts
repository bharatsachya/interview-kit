import type {
  Difficulty,
  InternalFlashcard,
  InternalKit,
  InternalQuestion,
  Origin,
  QuestionCategory,
  Requirement,
} from "../src/types";

/**
 * A small, realistic kit to mutate in tests. Deliberately hand-written rather than generated —
 * a fixture you can read is worth more than one that is clever.
 */

let seq = 0;
export function resetIds(): void {
  seq = 0;
}

export function makeQuestion(overrides: Partial<InternalQuestion> = {}): InternalQuestion {
  seq += 1;
  return {
    id: `q${seq}`,
    category: "technical",
    prompt: `Question ${seq}?`,
    answerOutline: `Outline ${seq}.`,
    difficulty: 2,
    requirementIds: ["r1"],
    origin: "generated",
    pinned: false,
    active: true,
    order: seq,
    ...overrides,
  };
}

export function makeFlashcard(overrides: Partial<InternalFlashcard> = {}): InternalFlashcard {
  seq += 1;
  return {
    id: `f${seq}`,
    front: `Front ${seq}?`,
    back: `Back ${seq}.`,
    requirementIds: ["r1"],
    questionId: null,
    origin: "generated",
    pinned: false,
    active: true,
    order: seq,
    ...overrides,
  };
}

export const REQUIREMENTS: Requirement[] = [
  { id: "r1", text: "Five years of Python", kind: "technical", priority: "must" },
  { id: "r2", text: "Mentoring junior engineers", kind: "behavioural", priority: "must" },
  { id: "r3", text: "Payments domain experience", kind: "domain", priority: "nice" },
];

export function makeKit(overrides: Partial<InternalKit> = {}): InternalKit {
  const questions = overrides.questions ?? [
    makeQuestion({ id: "q1", category: "technical", requirementIds: ["r1"], difficulty: 3, order: 0 }),
    makeQuestion({ id: "q2", category: "behavioural", requirementIds: ["r2"], difficulty: 1, order: 0 }),
  ];

  return {
    id: "kit_1",
    createdAt: 1_700_000_000_000,
    role: {
      title: "Senior Backend Engineer",
      company: "Acme",
      location: "Berlin, hybrid",
      summary: "Backend work on the payments platform.",
      responsibilities: ["Own the ledger service"],
    },
    companyBrief: {
      summary: "Acme builds payment infrastructure.",
      whatTheyDo: "Card processing for marketplaces.",
      hiringProcess: "Take-home followed by a system design round.",
      sources: ["https://acme.test/"],
      pagesUsed: ["https://acme.test/", "https://acme.test/handbook/hiring"],
      gaps: [],
      edited: false,
    },
    requirements: REQUIREMENTS,
    questions,
    flashcards: overrides.flashcards ?? [
      makeFlashcard({ id: "f1", questionId: "q1", requirementIds: ["r1"], order: 0 }),
      makeFlashcard({ id: "f2", questionId: "q2", requirementIds: ["r2"], order: 1 }),
    ],
    schedule: overrides.schedule ?? {
      daysAvailable: 2,
      days: [
        { day: 1, focus: "Technical depth", questionIds: ["q1"], minutes: 30, edited: false },
        { day: 2, focus: "Behavioural", questionIds: ["q2"], minutes: 10, edited: false },
      ],
    },
    coverage: { passes: 1, uncoveredRequirementIds: ["r3"] },
    ...overrides,
  };
}

/** A minimal valid Appendix A document, for schema tests that mutate one field at a time. */
export function makeKitJSON(): Record<string, unknown> {
  return {
    id: "kit_1",
    role: {
      title: "Senior Backend Engineer",
      company: "Acme",
      location: "Berlin",
      summary: "Backend.",
      responsibilities: ["Own the ledger service"],
    },
    company_brief: {
      summary: "Acme builds payment infrastructure.",
      what_they_do: "Card processing.",
      hiring_process: "Take-home then system design.",
      sources: ["https://acme.test/"],
      pages_used: ["https://acme.test/"],
      gaps: [],
    },
    requirements: [{ id: "r1", text: "Five years of Python", kind: "technical", priority: "must" }],
    questions: [
      {
        id: "q1",
        category: "technical",
        prompt: "Walk through a hard Python problem you solved.",
        answer_outline: "Context, constraint, approach, outcome.",
        difficulty: 2,
        requirement_ids: ["r1"],
      },
    ],
    flashcards: [{ id: "f1", front: "Hard Python problem?", back: "Context, constraint, approach.", requirement_ids: ["r1"] }],
    schedule: {
      days_available: 1,
      days: [{ day: 1, focus: "Technical depth", question_ids: ["q1"], minutes: 20 }],
    },
    coverage: { passes: 1, uncovered_requirement_ids: [] },
  };
}

export const CATEGORIES: QuestionCategory[] = ["technical", "behavioural", "system-design", "company-fit"];
export const ORIGINS: Origin[] = ["generated", "edited", "manual", "fallback"];
export const DIFFICULTIES: Difficulty[] = [1, 2, 3];
