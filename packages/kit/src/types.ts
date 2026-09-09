/**
 * The internal kit shape.
 *
 * Storage carries fields Appendix A never sees. That is deliberate: the projection is the
 * contract, so the output spec never constrains the database.
 *
 * Internal fields are camelCase, Appendix A is snake_case. The casing difference is not
 * cosmetic — it means `toKitJSON` has to construct every output field by hand, so no internal
 * field can leak into the export by being forgotten in a delete-list.
 */

export type RequirementKind = "technical" | "behavioural" | "domain";
export type RequirementPriority = "must" | "nice";
export type QuestionCategory = "technical" | "behavioural" | "system-design" | "company-fit";

export const QUESTION_CATEGORIES: readonly QuestionCategory[] = [
  "technical",
  "behavioural",
  "system-design",
  "company-fit",
] as const;

/** 1 easy, 2 medium, 3 hard. Drives both the minutes table and schedule front-loading. */
export type Difficulty = 1 | 2 | 3;

/**
 * Where an item came from.
 *
 * `edited` and `pinned` are separate on purpose: "the user changed this" and "the user wants
 * this kept" are different intents, and only the second one should survive a regeneration the
 * user explicitly asked for.
 */
export type Origin = "generated" | "edited" | "manual" | "fallback";

export interface Requirement {
  id: string;
  /** A phrase from the posting, not a paraphrase. Nothing here is ever invented. */
  text: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  /**
   * The sentence of the posting this was taken from. Internal only — never in Appendix A output.
   *
   * Extraction always sets it; a requirement built by hand in a test may not. Coverage's gap fill
   * and the overlap gate read it to judge a generated question against the words the requirement
   * actually sits in, rather than against the phrase extraction trimmed it down to.
   */
  sourceSpan?: string;
}

/** Fields every user-editable item carries. Never in the Appendix A output. */
export interface Provenance {
  origin: Origin;
  pinned: boolean;
  /**
   * Soft delete. Deleted items are never removed internally and ids are never reused, which
   * makes a dangling reference impossible in storage. Archived items are invisible in the UI —
   * the brief says "delete", not "archive", so there is no Removed list and no restore.
   */
  active: boolean;
  /** Position within the category, for builder reordering. */
  order: number;
}

export interface InternalQuestion extends Provenance {
  id: string;
  category: QuestionCategory;
  prompt: string;
  answerOutline: string;
  difficulty: Difficulty;
  requirementIds: string[];
}

export interface InternalFlashcard extends Provenance {
  id: string;
  front: string;
  back: string;
  requirementIds: string[];
  /** The question this was derived from, so regeneration can drop the pair together. */
  questionId: string | null;
}

export interface InternalDay {
  /** 1-based. */
  day: number;
  focus: string;
  questionIds: string[];
  minutes: number;
  /**
   * Set once the user touches this day. Recompute skips edited days — regenerating a question
   * category must not wipe a day focus somebody rewrote.
   */
  edited: boolean;
}

export interface InternalSchedule {
  daysAvailable: number;
  days: InternalDay[];
}

export interface CompanyBrief {
  summary: string;
  whatTheyDo: string;
  /** What the company says about how it interviews. Empty when no hiring page was found. */
  hiringProcess: string;
  /** Every URL consulted, including search results. */
  sources: string[];
  /** Pages actually fetched and used in the prompt. */
  pagesUsed: string[];
  /**
   * What could not be found, in plain words. An extension to Appendix A: the degradation
   * ladder requires a missing search provider or an unreachable site to be *recorded*, and a
   * brief that silently omits a section is indistinguishable from one that had nothing to say.
   */
  gaps: string[];
  edited: boolean;
}

export interface RoleSummary {
  title: string;
  company: string;
  /** Required by Appendix A. Extracted from the posting if present, empty string otherwise. */
  location: string;
  summary: string;
  /**
   * What the role does, as opposed to what the candidate must have.
   *
   * The other half of extraction's two piles. Keeping it means the "what you'll build" sentences
   * of a posting have somewhere to go that is not the requirement list.
   */
  responsibilities: string[];
}

export interface CoverageReport {
  /** How many coverage passes actually ran. Recorded honestly, never rounded up. */
  passes: number;
  /** Must-haves still uncovered after fallback, plus nice-to-haves, which never block. */
  uncoveredRequirementIds: string[];
}

export interface InternalKit {
  id: string;
  createdAt: number;
  role: RoleSummary;
  companyBrief: CompanyBrief;
  requirements: Requirement[];
  questions: InternalQuestion[];
  flashcards: InternalFlashcard[];
  schedule: InternalSchedule;
  coverage: CoverageReport;
}
