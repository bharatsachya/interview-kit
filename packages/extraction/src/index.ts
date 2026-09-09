/**
 * @trao/extraction — job description to requirements.
 *
 * Worth 20 points, the largest single item. The model reads; the code decides what is real,
 * what it is called, and — where the posting says so — how important it is.
 */

export {
  CHARS_PER_REQUIREMENT,
  MAX_JD_CHARS,
  MAX_RESPONSIBILITIES,
  PRIORITY_SANITY_MIN_CHARS,
  extractRequirements,
  sanityCheck,
  type DroppedRequirement,
  type ExtractionInput,
  type ExtractionResult,
  type SanityVerdict,
} from "./extract";
export {
  MAX_BARE_NAME_TOKENS,
  collapseExampleLists,
  isBareName,
  type CollapseResult,
  type MergedGroup,
  type SpannedCandidate,
} from "./merge";
export { MIN_SPAN_CONFIDENCE, locateSpan, spansOf, type JdSpan, type SpanMatch } from "./spans";
export { MIN_GROUNDING_RATIO, checkGrounding, type GroundingVerdict } from "./grounding";
export { inlinePriority, locateLine, priorityFromPosting, sectionsOf, type JdSection } from "./sections";
export { contentTokens, normalise } from "./text";
