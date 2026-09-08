/**
 * Prompt hygiene now lives in contracts, next to `LlmRequest`, because extraction and generation
 * both embed untrusted text in prompts and neither may import this package.
 *
 * Re-exported here so gateway code reads naturally and nothing outside has to know where they
 * moved.
 */
export {
  DEFAULT_MAX_PAGE_CHARS,
  estimateTokens,
  truncateForPrompt,
  untrustedBlock,
} from "@trao/contracts";
