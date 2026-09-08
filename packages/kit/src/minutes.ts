import type { Difficulty } from "./types";

/**
 * Study minutes per question, by difficulty. Fixed table, integers only.
 *
 * This lives in `kit` rather than in `scheduling` because a day's `minutes` is a derived
 * Appendix A field — derived from another Appendix A field on the same document. Allocation
 * (H3) and repair (here) both need it, and one shared table is the only way the two can never
 * disagree about what a day is worth.
 */
export const MINUTES_BY_DIFFICULTY: Readonly<Record<Difficulty, number>> = {
  1: 10,
  2: 20,
  3: 30,
};

export function minutesForDifficulty(difficulty: Difficulty): number {
  return MINUTES_BY_DIFFICULTY[difficulty];
}

/** Sum of the day's questions. Always an integer, because every term is. */
export function minutesForQuestions(questions: readonly { difficulty: Difficulty }[]): number {
  return questions.reduce((total, q) => total + minutesForDifficulty(q.difficulty), 0);
}
