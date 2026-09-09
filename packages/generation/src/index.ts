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
export { createGapFillWriter, type GapFillDraft, type GapFillWriterOptions } from "./gap-fill";
export {
  DEFAULT_QUESTIONS_PER_CATEGORY,
  generateQuestions,
  requirementsFor,
  responsibilitiesFor,
  type CategoryReport,
  type QuestionGenerationInput,
  type QuestionGenerationResult,
} from "./questions";
