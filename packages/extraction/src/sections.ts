import type { RequirementPriority } from "@trao/kit";
import { contentTokens, normalise } from "./text";

/**
 * Which part of the posting a requirement came from.
 *
 * The rubric names this specifically: priority comes from **how the posting words it**. A
 * "Required:" line and a "Bonus points for:" line are not the same thing, and a model asked for
 * a must/nice judgement gets it wrong often enough to matter — usually by marking everything
 * `must`, because job postings sound urgent.
 *
 * So the posting is split on its own headings, each heading is classified, and a requirement
 * that falls under a "nice to have" heading is `nice` whatever the model said. The model's
 * answer is the fallback for text that sits under no heading at all.
 */

const NICE_HEADING =
  /\b(nice[\s-]?to[\s-]?have|bonus|preferred|desirable|would be (?:a )?(?:plus|great|nice)|good to have|pluses|advantageous|optional|ideally)\b/i;

/**
 * Not all must-headings are equally strong, and the difference decides a real conflict.
 *
 * "Required:" is an explicit statement of necessity. "What we're looking for" is a section
 * label that happens to introduce requirements. When a line under the former says "though Helm
 * is a plus", the requirement is still required — the aside is about a sub-part. When a line
 * under the latter says "Prior work on AI products is a plus", the line is the more specific
 * statement and it wins.
 *
 * Treating every must-heading as absolute marked all twenty requirements of a prose posting
 * `must`, including the one it explicitly called a plus.
 */
const STRONG_MUST_HEADING =
  /\b(required|requirements|must[\s-]?have|essential|minimum|you(?:'| a)?ll need|what you(?:'| wi)?ll need|non-?negotiable)\b/i;

const WEAK_MUST_HEADING =
  /\b(qualifications|who you are|about you|we(?:'| a)?re looking for|responsibilities|what you(?:'| wi)?ll do)\b/i;

const MUST_HEADING = new RegExp(`${STRONG_MUST_HEADING.source}|${WEAK_MUST_HEADING.source}`, "i");

/**
 * Priority stated inside the line itself rather than by a heading.
 *
 * "Prior work on AI or agent products is a plus" is a nice-to-have, and a posting written as
 * prose says so this way instead of putting it under a "Nice to have:" heading. Heading
 * detection alone marked every requirement in such a posting `must`, which is precisely the
 * distinction the rubric names.
 */
const INLINE_NICE =
  /\b(is a plus|are a plus|a bonus|bonus points|nice to have|would be (?:a )?(?:plus|bonus|nice|great)|preferred|ideally|desirable|not required|optional)\b/i;

const INLINE_MUST = /\b(must have|required|essential|you will need|non-?negotiable)\b/i;

/** `null` when the line says nothing either way. */
export function inlinePriority(text: string): RequirementPriority | null {
  if (INLINE_NICE.test(text)) return "nice";
  if (INLINE_MUST.test(text)) return "must";
  return null;
}

export interface JdSection {
  heading: string;
  priority: RequirementPriority | null;
  /** Line indexes, half-open. */
  startLine: number;
  endLine: number;
}

/**
 * A heading is a short line that announces a section.
 *
 * Length-capped because a sentence in a paragraph can easily contain the word "required"
 * ("experience with Kubernetes is required for this role") without being a heading. Treating
 * that as a section boundary would re-label everything after it.
 */
const MAX_HEADING_CHARS = 90;

export function sectionsOf(jd: string): JdSection[] {
  const lines = jd.split(/\r?\n/);
  const sections: JdSection[] = [];

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.length > MAX_HEADING_CHARS) continue;

    // A heading either ends in a colon or is a short standalone line. A bulleted item is not a
    // heading, however it is worded.
    const looksLikeHeading = line.endsWith(":") || (!/^[-*•\d]/.test(line) && line.split(/\s+/).length <= 8);
    if (!looksLikeHeading) continue;

    const priority = NICE_HEADING.test(line) ? "nice" : MUST_HEADING.test(line) ? "must" : null;
    if (priority === null) continue;

    const previous = sections.at(-1);
    if (previous !== undefined) previous.endLine = index;
    sections.push({ heading: line, priority, startLine: index, endLine: lines.length });
  }

  return sections;
}

/**
 * The priority the posting implies for this requirement, or null when it says nothing.
 *
 * Located by verbatim match first, then by best token overlap — the model's phrasing is usually
 * but not always identical to the posting's.
 */
export function priorityFromPosting(
  requirementText: string,
  jd: string,
  sections: readonly JdSection[],
): RequirementPriority | null {
  const line = locateLine(requirementText, jd);

  // Checked against the source line, not only the extracted phrase — "is a plus" usually sits
  // in the part of the sentence that extraction trimmed off.
  const sourceLine = line === null ? "" : (jd.split(/\r?\n/)[line] ?? "");
  const inline = inlinePriority(`${requirementText} ${sourceLine}`);

  if (line !== null) {
    for (const section of sections) {
      if (line <= section.startLine || line >= section.endLine) continue;

      // An explicit "is a plus" on the line beats a mere section label, but not an explicit
      // "Required:" heading.
      const strong = STRONG_MUST_HEADING.test(section.heading) || NICE_HEADING.test(section.heading);
      if (!strong && inline !== null) return inline;
      return section.priority;
    }
  }

  return inline;
}

/** Index of the line the requirement most likely came from, or null when nothing matches. */
export function locateLine(requirementText: string, jd: string): number | null {
  const lines = jd.split(/\r?\n/);
  const needle = normalise(requirementText);

  for (const [index, line] of lines.entries()) {
    if (normalise(line).includes(needle)) return index;
  }

  const wanted = new Set(contentTokens(requirementText));
  if (wanted.size === 0) return null;

  let best: { index: number; score: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const present = new Set(contentTokens(line));
    let shared = 0;
    for (const token of wanted) if (present.has(token)) shared += 1;

    const score = shared / wanted.size;
    if (score > (best?.score ?? 0)) best = { index, score };
  }

  // Half the words in one line, or it is not really that line.
  return best !== null && best.score >= 0.5 ? best.index : null;
}
