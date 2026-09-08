import type { Difficulty, InternalQuestion, QuestionCategory, Requirement } from "@trao/kit";

let seq = 0;
export function resetIds(): void {
  seq = 0;
}

export function question(overrides: Partial<InternalQuestion> = {}): InternalQuestion {
  seq += 1;
  return {
    id: `q${seq}`,
    category: "technical",
    prompt: `Question ${seq}?`,
    answerOutline: `Outline ${seq}.`,
    difficulty: 2,
    requirementIds: ["r-must"],
    origin: "generated",
    pinned: false,
    active: true,
    order: seq,
    ...overrides,
  };
}

export const REQUIREMENTS: Requirement[] = [
  { id: "r-must", text: "Five years of Python", kind: "technical", priority: "must" },
  { id: "r-must-2", text: "Mentoring junior engineers", kind: "behavioural", priority: "must" },
  { id: "r-nice", text: "Payments domain experience", kind: "domain", priority: "nice" },
];

/**
 * A realistic kit's worth of questions: four categories, mixed difficulty, and — importantly —
 * every requirement covered by at least one question. The allocator can only schedule questions
 * that exist; making sure a must-have has one at all is the coverage package's job.
 */
export function realisticQuestions(): InternalQuestion[] {
  resetIds();
  const categories: QuestionCategory[] = ["technical", "behavioural", "system-design", "company-fit"];
  const difficulties: Difficulty[] = [1, 2, 3];
  const requirementIds = REQUIREMENTS.map((r) => r.id);

  return categories.flatMap((category, c) =>
    difficulties.flatMap((difficulty, d) =>
      [0, 1].map((n) =>
        question({
          category,
          difficulty,
          requirementIds: [requirementIds[(c + d + n) % requirementIds.length] as string],
        }),
      ),
    ),
  );
}
