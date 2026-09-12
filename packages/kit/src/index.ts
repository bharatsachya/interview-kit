/**
 * @trao/kit — the kit document: its internal shape, the Appendix A projection, and every
 * state transition the builder performs on it.
 *
 * Imported by anything producing kit-shaped data. Imports nothing but contracts and zod.
 */

export {
  kitJsonSchema,
  validateKitJSON,
  type KitJSON,
  type KitJSONDay,
  type KitJSONFlashcard,
  type KitJSONQuestion,
  type KitValidationResult,
} from "./appendix-a";

export {
  evaluationOutputSchema,
  parseCases,
  parseCasesJSON,
  validateEvaluationOutput,
  type EvaluationCase,
  type EvaluationOutput,
  type EvaluationResult,
  type ParseCasesResult,
  type ValidateOutputResult,
} from "./appendix-b";

export {
  addFlashcard,
  addManualQuestion,
  addQuestion,
  archiveFlashcard,
  archiveQuestion,
  deleteFlashcard,
  deleteQuestion,
  editBrief,
  editFlashcard,
  editQuestion,
  editScheduleDay,
  moveQuestion,
  pinQuestion,
  regenerateCategory,
  reorderQuestions,
  setQuestionPinned,
  type BriefPatch,
  type FlashcardDraft,
  type FlashcardPatch,
  type NewQuestion,
  type QuestionDraft,
  type QuestionPatch,
  type SchedulePatch,
} from "./edits";

export { commit, VersionConflictError, type MutationOptions } from "./version";

export { forkKit, lineageLabel } from "./fork";

export { MINUTES_BY_DIFFICULTY, minutesForDifficulty, minutesForQuestions } from "./minutes";

export { getKitForBuilder, toKitJSON, tryToKitJSON, type BuilderKit, type ToKitJSONResult } from "./projections";

export { repairSchedule } from "./repair";

export {
  QUESTION_CATEGORIES,
  type CompanyBrief,
  type CoverageReport,
  type Difficulty,
  type InternalDay,
  type InternalFlashcard,
  type InternalKit,
  type InternalQuestion,
  type InternalSchedule,
  type KitLineage,
  type Origin,
  type Provenance,
  type QuestionCategory,
  type Requirement,
  type RequirementKind,
  type RequirementPriority,
  type RoleSummary,
} from "./types";
