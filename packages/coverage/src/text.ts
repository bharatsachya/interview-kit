/**
 * Text comparison for the acceptance gates. Deliberately not semantic.
 *
 * A shared-term threshold is inspectable, deterministic and free. An embedding call to decide
 * whether a question is about the right thing would cost quota on a step worth no points, and
 * could not be reasoned about from a trace.
 */

const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "for", "from", "had", "has", "have",
  "how", "in", "into", "is", "it", "its", "may", "might", "must", "of", "on", "or", "our", "out",
  "over", "should", "so", "some", "such", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "those", "to", "up", "us", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "will", "with", "would", "you", "your",
  // Job-description filler that appears in almost every posting and every question.
  "ability", "able", "experience", "experienced", "role", "strong", "work", "working", "years",
  "year", "plus", "good", "great", "excellent", "solid", "familiar", "familiarity", "knowledge",
  "understanding", "skills", "skill", "using", "use", "used", "team", "teams",
]);

/** Lowercase, strip punctuation, split, drop stopwords and one-character noise. */
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[.]+|[.]+$/g, ""))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Every token, stopwords included. Used where the question is whether anything was invented. */
export function allTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[.]+|[.]+$/g, ""))
    .filter((token) => token.length > 0);
}

export function normalise(text: string): string {
  return contentTokens(text).sort().join(" ");
}

/**
 * How much of the requirement's vocabulary the question actually uses.
 *
 * Measured against the requirement rather than symmetrically: a long, thorough question about a
 * short requirement should score well, and Jaccard would punish it for the length.
 */
export function overlapRatio(requirementText: string, questionText: string): number {
  const required = new Set(contentTokens(requirementText));
  if (required.size === 0) return 1; // Nothing to match against — the gate cannot judge it.

  const present = new Set(contentTokens(questionText));
  let shared = 0;
  for (const token of required) if (present.has(token)) shared += 1;
  return shared / required.size;
}

/** Symmetric similarity, for spotting a rephrase of a question we already have. */
export function jaccard(a: string, b: string): number {
  const left = new Set(contentTokens(a));
  const right = new Set(contentTokens(b));
  if (left.size === 0 && right.size === 0) return 1;

  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
