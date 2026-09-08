/**
 * Text helpers shared by grounding and section detection.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "for", "from", "have", "in", "is", "it", "of", "on",
  "or", "our", "the", "to", "with", "you", "your", "we", "will", "can", "that", "this",
]);

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Content-bearing words. `+` and `#` survive so "C++" and "C#" stay themselves. */
export function contentTokens(text: string): string[] {
  return normalise(text)
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}
