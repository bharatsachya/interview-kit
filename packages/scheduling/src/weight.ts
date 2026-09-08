import type { InternalQuestion, Requirement, RequirementPriority } from "@trao/kit";

/**
 * How urgent a question is: `difficulty × priority`.
 *
 * Priority comes from the requirements the question covers — a question covering any must-have
 * is a must-have question. Range is 1 (easy, nice-to-have) to 6 (hard, must-have), and it is
 * the only thing that decides ordering. Nothing about this is a judgement call the model could
 * make better; it is arithmetic, so it lives in code.
 */

const PRIORITY_WEIGHT: Readonly<Record<RequirementPriority, number>> = {
  must: 2,
  nice: 1,
};

export function questionWeight(question: InternalQuestion, requirements: ReadonlyMap<string, Requirement>): number {
  return question.difficulty * priorityWeight(question, requirements);
}

/** A question covering several requirements takes the highest priority among them. */
export function priorityWeight(
  question: InternalQuestion,
  requirements: ReadonlyMap<string, Requirement>,
): number {
  let weight = PRIORITY_WEIGHT.nice;
  for (const id of question.requirementIds) {
    const requirement = requirements.get(id);
    if (requirement && PRIORITY_WEIGHT[requirement.priority] > weight) {
      weight = PRIORITY_WEIGHT[requirement.priority];
    }
  }
  return weight;
}

/**
 * Hardest and most important first.
 *
 * Ties break on difficulty, then the user's ordering, then id — so the same inputs always
 * produce the same schedule. A flaky schedule is a flaky test, and the brief names schedule
 * allocation as a mandatory test area.
 */
export function byUrgency(
  requirements: ReadonlyMap<string, Requirement>,
): (a: InternalQuestion, b: InternalQuestion) => number {
  return (a, b) => {
    const byWeight = questionWeight(b, requirements) - questionWeight(a, requirements);
    if (byWeight !== 0) return byWeight;
    if (b.difficulty !== a.difficulty) return b.difficulty - a.difficulty;
    if (a.order !== b.order) return a.order - b.order;
    return a.id.localeCompare(b.id);
  };
}

export function indexRequirements(requirements: readonly Requirement[]): ReadonlyMap<string, Requirement> {
  return new Map(requirements.map((r) => [r.id, r]));
}
