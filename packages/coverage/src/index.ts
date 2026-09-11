/**
 * @trao/coverage — is every must-have requirement actually asked about?
 *
 * Two rules the whole package exists to hold:
 *   1. The model never decides whether a gap is closed. A set difference does.
 *   2. The model never assigns requirement ids. The code attaches them, because the code chose
 *      which requirement it was asking about.
 *
 * Pure: no provider, no network, no clock. Gap fill receives a `GapFillWriter` function.
 */

export { MAX_CLUSTER_SIZE, clusterRequirements } from "./cluster";
export { detectGaps, type CoverageGaps } from "./detect";
export { FALLBACK_TEMPLATES, fallbackQuestion, type FallbackDraft } from "./fallback";
export {
  AMBIGUOUS_REQUIREMENT_TOKENS,
  MAX_DUPLICATE_SIMILARITY,
  MAX_REQUIREMENT_IDS_PER_QUESTION,
  MIN_OVERLAP_RATIO,
  MIN_PROMPT_TOKENS,
  acceptGapFill,
  contextTokens,
  coversRequirement,
  gateQuestionTags,
  type CoverageVerdict,
  type GateInput,
  type GateRejection,
  type GateResult,
  type TagGateResult,
} from "./gates";
export {
  DEFAULT_MAX_ATTEMPTS_PER_REQUIREMENT,
  DEFAULT_MAX_EXTRA_PASSES,
  runCoverage,
  type CoverageRunInput,
  type CoverageRunResult,
  type GapFillAttempt,
  type GapFillDraft,
  type GapFillRequest,
  type GapFillWriter,
  type PassReport,
  type RetagReport,
} from "./run";
export { contentTokens, jaccard, normalise, overlapRatio } from "./text";
