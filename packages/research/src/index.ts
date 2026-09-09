/**
 * @trao/research — public discussion of how a company interviews.
 *
 * The whole package is optional at runtime: no API key means `NullSearchProvider`, empty results
 * and a `skipped` step. Nothing here is ever allowed to fail a run.
 */

export {
  discussionQuery,
  searchDiscussion,
  type DiscussionSearchInput,
  type DiscussionSearchResult,
} from "./discussion";
export { NullSearchProvider, TavilySearchProvider, type TavilyOptions } from "./providers";
export { filterRelevant, type RelevanceInput, type RelevanceOutcome } from "./relevance";
