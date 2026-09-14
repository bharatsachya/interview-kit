/**
 * @trao/generation — the company brief, the four question categories, and the derived flashcards.
 *
 * Receives an `LlmProvider`; never constructs one. Flashcards make no model call at all.
 */

export {
  generateBrief,
  type BriefInput,
  type BriefResult,
  type DiscussionItem,
  type SourcePage,
} from "./brief";
export { deriveFlashcards, frontFor } from "./flashcards";
export { fundamentalsFor, type FundamentalsInput } from "./fundamentals";
export { steerLines } from "./steer";
export { checkClaims, claimsIn, type Claim, type ClaimCheck, type ClaimKind } from "./claims";
export { createGapFillWriter, type GapFillDraft, type GapFillWriterOptions } from "./gap-fill";
export {
  DEFAULT_QUESTIONS_PER_CATEGORY,
  generateCategoryQuestions,
  generateQuestions,
  requirementsFor,
  responsibilitiesFor,
  type CategoryReport,
  type QuestionDraft,
  type QuestionGenerationInput,
  type QuestionGenerationResult,
} from "./questions";
