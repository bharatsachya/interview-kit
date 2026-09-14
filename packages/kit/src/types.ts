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
/**
 * Where an item came from, which is what decides whether a regeneration may take it back.
 *
 * `generated` is the only disposable one — see `regenerateCategory`. The other four are all
 * things the machine must not quietly undo: the user's own words, the user's edit, a question
 * written in code because coverage had a hole, and a fundamentals question that was never
 * derived from the posting in the first place.
 */
export type Origin = "generated" | "edited" | "manual" | "fallback" | "fundamentals";

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
   * The cleaned page text the brief was written from. Internal only — never in Appendix A.
   *
   * Kept because regenerating the brief has to re-run generation against the passages the first
   * run read, and `pagesUsed` is a list of bare URLs. Prompting a model with URLs and no page
   * bodies is exactly the fabrication `generateBrief` exists to prevent: it would have nothing
   * to write from and would write anyway.
   *
   * Optional so kits stored before this field existed still load; a regeneration that finds it
   * absent falls back to `pagesUsed` and records the degradation rather than inventing text.
   */
  passages?: { url: string; title: string; text: string }[];
  /**
   * Where the brief's words came from, on the same scale as a question's.
   *
   * `edited` below is kept because it is what the pipeline sets, and because "this was touched"
   * and "this is the user's now" answer different questions. A regeneration reads `origin`.
   */
  origin: Origin;
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

/**
 * What a rewrite was asked to do, kept on the kit it produced.
 *
 * A rewrite forks: the kit you were looking at is left exactly as it was and a new document is
 * written beside it. That only reads as a version history if each fork says where it came from
 * and what it was asked for — without this a user with four Vaultline kits in the rail has four
 * identical rows and no way to tell which one has the questions they wanted.
 *
 * `instructions` is the candidate's own words from the composer, stored verbatim. It is the
 * only part of this a model ever sees, and it is fenced as untrusted input when it gets there.
 */
export interface KitLineage {
  /** The kit this one was rewritten from. Still present; a fork never touches its parent. */
  fromKitId: string;
  section: "company_brief" | "questions" | "schedule";
  /** Set only when `section` is `questions` — the one category that was rewritten. */
  category?: QuestionCategory;
  /** What the composer was sent with, if anything was typed. Never invented. */
  instructions?: string;
  at: number;
}

export interface InternalKit {
  id: string;
  createdAt: number;
  /**
   * Where this kit came from, when it was not built from a posting.
   *
   * Absent on a kit the pipeline built — that one came from a job description, which the run's
   * own job record already holds. Present on every fork a rewrite produced.
   */
  forkedFrom?: KitLineage;
  /**
   * How many rewrites deep this kit is. 1 for anything the pipeline built.
   *
   * Stored rather than derived by walking `forkedFrom` back through the store: the rail labels
   * every row and a walk would be one round trip per row per render. Optional because kits
   * written before forking existed have no number, and those are all originals.
   */
  revision?: number;
  /**
   * Bumped by exactly one on every builder mutation.
   *
   * The builder is a set of small writes against a document two tabs can hold at once. Without a
   * version, the second tab's save silently reinstates whatever the first tab deleted — the user
   * sees their own edit undo itself and has no way to know why. Callers that pass `ifVersion`
   * get a `VersionConflictError` carrying the current number instead, and can refetch.
   *
   * Not a timestamp: two writes inside the same millisecond are ordinary, and a counter cannot
   * tie. Not a hash: the point is to be comparable, not to detect what changed.
   */
  version: number;
  role: RoleSummary;
  companyBrief: CompanyBrief;
  requirements: Requirement[];
  questions: InternalQuestion[];
  flashcards: InternalFlashcard[];
  schedule: InternalSchedule;
  coverage: CoverageReport;
}
