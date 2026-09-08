import { contentTokens, normalise } from "./text";

/**
 * Is this requirement actually in the posting?
 *
 * The rubric's words are that the must-haves are found, marked correctly, and **nothing is
 * invented**. A model asked to extract will happily add "Docker" to a posting that never
 * mentions it, because postings like this one usually do. So every requirement the model returns
 * is checked back against the source before it is kept.
 *
 * Not an exact substring match — that would drop "5+ years of Python" for saying "5+" where the
 * model wrote "five". A token-coverage floor catches invention (a requirement whose distinctive
 * words simply are not there) while tolerating the small rewordings that are not the problem.
 */

/** Share of a requirement's content words that must appear in the posting. */
export const MIN_GROUNDING_RATIO = 0.6;

export interface GroundingVerdict {
  grounded: boolean;
  ratio: number;
  /** The words that are not in the posting. Recorded when something is dropped. */
  missing: string[];
}

export function checkGrounding(requirementText: string, jd: string, minRatio = MIN_GROUNDING_RATIO): GroundingVerdict {
  const required = contentTokens(requirementText);
  if (required.length === 0) return { grounded: false, ratio: 0, missing: [] };

  // A verbatim phrase is grounded by definition, whatever the token maths says.
  if (normalise(jd).includes(normalise(requirementText))) {
    return { grounded: true, ratio: 1, missing: [] };
  }

  const present = new Set(contentTokens(jd));
  const missing = required.filter((token) => !present.has(token));
  const ratio = (required.length - missing.length) / required.length;

  return { grounded: ratio >= minRatio, ratio, missing };
}
