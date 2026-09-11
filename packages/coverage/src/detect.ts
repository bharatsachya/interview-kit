import type { InternalQuestion, Requirement } from "@trao/kit";

/**
 * Gap detection: a set difference, in code.
 *
 * The brief names this as one of the two steps that must not be handed to the model, and the
 * reason is concrete. If the model returns a question tagged `requirement_ids: ["r7"]`, a naive
 * checker sees r7 covered — even when the question is about something else entirely. The model
 * mislabels, the checker believes it, and the kit ships with a fake pass.
 *
 * The defence is upstream, in gap fill: the model is never asked which requirement a question
 * covers. Here we only count.
 */

export interface CoverageGaps {
  /** Must-haves with no active question referencing them. These block. */
  uncoveredMustIds: string[];
  /** Nice-to-haves with no question. Reported so the field means something; never block. */
  uncoveredNiceIds: string[];
  coveredIds: string[];
}

export function detectGaps(
  requirements: readonly Requirement[],
  questions: readonly InternalQuestion[],
): CoverageGaps {
  const covered = new Set<string>();
  for (const question of questions) {
    if (!question.active) continue; // An archived question covers nothing.
    for (const id of question.requirementIds) covered.add(id);
  }

  const uncoveredMustIds: string[] = [];
  const uncoveredNiceIds: string[] = [];
  const coveredIds: string[] = [];

  for (const requirement of requirements) {
    if (covered.has(requirement.id)) {
      coveredIds.push(requirement.id);
    } else if (requirement.priority === "must") {
      uncoveredMustIds.push(requirement.id);
    } else {
      uncoveredNiceIds.push(requirement.id);
    }
  }

  return { uncoveredMustIds, uncoveredNiceIds, coveredIds };
}
