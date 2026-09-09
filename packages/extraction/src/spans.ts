import { contentTokens, normalise } from "./text";

/**
 * The sentence of the posting a requirement came from.
 *
 * Two later steps need to know this, so it is computed once here rather than asked of the model:
 *
 *   1. **Collapsing example lists.** "Gmail, Drive, Slack, and the rest of their stack" is one
 *      sentence, and six requirements that all trace back to it are six copies of one need. The
 *      only way to see that is to know which sentence each requirement came from.
 *   2. **Gap fill and the overlap gate**, which compare a generated question against the words
 *      the requirement actually sits in rather than the trimmed phrase.
 *
 * The model is not asked for the span. It would paraphrase, and a paraphrased span cannot be
 * checked back against the posting — which is the entire point of having one.
 */

export interface JdSpan {
  /** Verbatim, except that a sentence wrapped across lines is joined with single spaces. */
  text: string;
  /** Index of the line the span starts on. */
  line: number;
}

export interface SpanMatch {
  span: JdSpan;
  /** 1 for a verbatim containment, otherwise the share of content words the span holds. */
  score: number;
}

/** Below this, the requirement and the span merely share a word or two. Too weak to merge on. */
export const MIN_SPAN_CONFIDENCE = 0.5;

const BULLET = /^\s*(?:[-*•‣▪]|\d+[.)])\s+/;

/**
 * The posting as a list of sentences.
 *
 * Line breaks and sentence breaks disagree in a real posting, so both are honoured: a bullet is
 * always its own span however it wraps, and a prose paragraph is rejoined before it is split on
 * its full stops. Splitting on lines alone would cut "…let users plug Gmail, Drive, Slack, and
 * the rest of / their stack into Magica." in half, and rejoining everything would fuse a block
 * of five bullets into one span.
 */
export function spansOf(jd: string): JdSpan[] {
  const lines = jd.split(/\r?\n/);
  const spans: JdSpan[] = [];

  let block: { lines: string[]; line: number } | null = null;

  const flush = (): void => {
    if (block === null) return;
    const joined = block.lines.join(" ").replace(/\s+/g, " ").trim();
    for (const sentence of splitSentences(joined)) {
      if (sentence.length > 0) spans.push({ text: sentence, line: block.line });
    }
    block = null;
  };

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();

    if (line.length === 0) {
      flush();
      continue;
    }

    // A bullet always starts a span; anything else continues the block it is wrapped into.
    if (BULLET.test(raw) || block === null) {
      flush();
      block = { lines: [line.replace(BULLET, "")], line: index };
    } else {
      block.lines.push(line);
    }
  }
  flush();

  return spans;
}

/**
 * The span a requirement most likely came from, or null when the posting has no spans at all.
 *
 * Always returns the best candidate rather than nothing, because every requirement that reaches
 * this point has already passed the grounding check — its words are in the posting somewhere, so
 * some span holds them. `score` is what callers use to decide whether the match is good enough
 * to act on.
 */
export function locateSpan(text: string, spans: readonly JdSpan[]): SpanMatch | null {
  if (spans.length === 0) return null;

  const needle = normalise(text);
  for (const span of spans) {
    if (normalise(span.text).includes(needle)) return { span, score: 1 };
  }

  const wanted = new Set(contentTokens(text));
  if (wanted.size === 0) return null;

  let best: SpanMatch | null = null;
  for (const span of spans) {
    const present = new Set(contentTokens(span.text));
    let shared = 0;
    for (const token of wanted) if (present.has(token)) shared += 1;

    const score = shared / wanted.size;
    if (score > (best?.score ?? 0)) best = { span, score };
  }

  return best;
}

/**
 * Sentence boundaries, conservatively.
 *
 * A break only counts where the next sentence visibly starts — a capital, a quote or a bracket.
 * "e.g. Kafka" and "5+ yrs. Python" are not two sentences.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=["'“(\p{Lu}])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}
