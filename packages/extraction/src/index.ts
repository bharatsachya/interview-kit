/**
 * @trao/extraction — job description to requirements.
 *
 * Worth 20 points, the largest single item. The model reads; the code decides what is real,
 * what it is called, and — where the posting says so — how important it is.
 */

export {
  MAX_JD_CHARS,
  extractRequirements,
  type DroppedRequirement,
  type ExtractionInput,
  type ExtractionResult,
} from "./extract";
export { MIN_GROUNDING_RATIO, checkGrounding, type GroundingVerdict } from "./grounding";
export { locateLine, priorityFromPosting, sectionsOf, type JdSection } from "./sections";
export { contentTokens, normalise } from "./text";
