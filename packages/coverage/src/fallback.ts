import type { Difficulty, QuestionCategory, Requirement, RequirementKind } from "@trao/kit";
import { contentTokens } from "./text";

/**
 * Deterministic fallback questions.
 *
 * After the passes are exhausted, a must-have that is still uncovered gets a question built in
 * code. No model involved — a model that has already failed twice on this requirement is not
 * going to succeed on a third ask, and the run has a budget.
 *
 * The hard rule: **never infer from the tech stack.** "React means they'll ask about hooks" is
 * our assumption, not the posting's. Every content word in the output comes from the
 * requirement text or the role title; the rest is fixed template. The two-line-JD case exists
 * to catch invented content, and this is the code most likely to invent some.
 *
 * Requirements are never generated — only questions. The requirement list stays strictly what
 * extraction found in the job description.
 */

/** Exported so the tests can subtract the boilerplate and check what is left came from the input. */
export const FALLBACK_TEMPLATES: Readonly<Record<RequirementKind, (subject: string) => string>> = {
  technical: (subject) =>
    `The role requires ${subject}. Walk through your experience with it and a hard problem you solved.`,
  behavioural: (subject) => `The role mentions ${subject}. Describe a time you did this and how it went.`,
  domain: (subject) =>
    `This role is in ${subject}. What's your background there, and what's specific about the domain?`,
};

const FALLBACK_CATEGORY: Readonly<Record<RequirementKind, QuestionCategory>> = {
  technical: "technical",
  behavioural: "behavioural",
  // A domain requirement is about the industry the company works in, which is the closest
  // thing the four categories have to "do you understand our world".
  domain: "company-fit",
};

/** Neutral middle. A fallback is a safety net, not a judgement about how hard the topic is. */
const FALLBACK_DIFFICULTY: Difficulty = 2;

export interface FallbackDraft {
  prompt: string;
  answerOutline: string;
  difficulty: Difficulty;
  category: QuestionCategory;
  requirementIds: string[];
}

export function fallbackQuestion(requirement: Requirement, roleTitle: string): FallbackDraft {
  // Too thin to slot into a sentence — "5+" or "Go" alone reads as a typo mid-template.
  const subject = contentTokens(requirement.text).length >= 2 ? requirement.text.trim() : roleTitle.trim();

  return {
    prompt: FALLBACK_TEMPLATES[requirement.kind](subject),
    // Deliberately empty rather than invented. An outline we made up would be the one part of
    // the kit a candidate could not tell was guessed.
    answerOutline: "",
    difficulty: FALLBACK_DIFFICULTY,
    category: FALLBACK_CATEGORY[requirement.kind],
    requirementIds: [requirement.id],
  };
}
