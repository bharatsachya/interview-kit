import type { InternalQuestion, Requirement } from "@trao/kit";
import { contentTokens, jaccard, normalise, overlapRatio } from "./text";

/**
 * Acceptance gates.
 *
 * A question has to earn the requirements it claims. A failed gate leaves the gap open — which
 * is the honest outcome, and lets the second pass or the deterministic fallback handle it.
 *
 * These originally ran on gap-fill answers only, which left the bulk path ungated and produced
 * two real failures on one live run:
 *
 *   - A single question was tagged with five requirement ids and marked both `Gmail` and `Slack`
 *     covered because it mentioned them in passing. Coverage believed it, reported no gap, and
 *     the kit shipped with neither integration genuinely asked about.
 *   - A gap-fill answer for the requirement `Drive` came back about motivation — "how do you
 *     maintain your drive" — and passed the overlap gate on the word "drive".
 *
 * Both are the same fault: the gate judged a question against a bare phrase. The fix is to judge
 * it against the sentence the requirement was taken from, and to run the gate on every question
 * rather than only the ones the model was asked to write twice.
 */

/** Below this share of the requirement's own vocabulary, the question is about something else. */
export const MIN_OVERLAP_RATIO = 0.25;

/** At or above this similarity to an existing question, it is a rephrase, not a new question. */
export const MAX_DUPLICATE_SIMILARITY = 0.8;

/** Fewer content-bearing words than this and there is no question here. */
export const MIN_PROMPT_TOKENS = 4;

/**
 * A requirement this short cannot be matched on its own words.
 *
 * "Drive" is one token. Any question containing the word "drive" scores a perfect overlap
 * against it, which is how a question about motivation came to cover a Google Drive
 * integration. For these, at least one word from the surrounding sentence has to appear too.
 */
export const AMBIGUOUS_REQUIREMENT_TOKENS = 2;

/** One question may honestly cover at most this many requirements. */
export const MAX_REQUIREMENT_IDS_PER_QUESTION = 3;

export type GateRejection =
  | "empty"
  | "stub"
  | "duplicate"
  | "no_overlap"
  | "name_drop"
  | "unsolicited_requirement_id";

export type GateResult = { accepted: true } | { accepted: false; reason: GateRejection };

/**
 * The words that disambiguate a requirement: those in its source sentence but not in the
 * requirement phrase itself.
 *
 * For `Drive`, taken from "the surfaces that let users plug Gmail, Drive and Slack into Magica",
 * these are gmail, slack, plug, surfaces, users, magica. A question about the integration will
 * use at least one of them; a question about personal motivation will use none.
 */
export function contextTokens(requirement: Requirement, siblings: readonly Requirement[] = []): string[] {
  if (requirement.sourceSpan === undefined) return [];

  const excluded = new Set(contentTokens(requirement.text));
  // Requirements extracted from the SAME sentence cannot disambiguate each other. Gmail, Drive
  // and Slack all come from one line, so a question naming Gmail and Slack in passing would
  // otherwise anchor each of them on the other and cover both. Their names are as ambiguous as
  // the one being tested; only the rest of the sentence is evidence.
  for (const sibling of siblings) {
    if (sibling.id === requirement.id) continue;
    if (sibling.sourceSpan !== requirement.sourceSpan) continue;
    for (const token of contentTokens(sibling.text)) excluded.add(token);
  }

  return contentTokens(requirement.sourceSpan).filter((token) => !excluded.has(token));
}

export interface CoverageVerdict {
  covers: boolean;
  ratio: number;
  reason?: "no_overlap" | "name_drop";
}

/**
 * Does this question genuinely cover this requirement?
 *
 * Two conditions, and the second only applies to requirements too short to identify themselves.
 * Ratio alone against a long source span would reject good questions — a thorough question about
 * a Drive integration still will not use most of the words in the sentence Drive came from — so
 * the span is used to disambiguate rather than to raise the bar.
 */
export function coversRequirement(
  requirement: Requirement,
  questionText: string,
  siblings: readonly Requirement[] = [],
): CoverageVerdict {
  const ratio = overlapRatio(requirement.text, questionText);
  if (ratio < MIN_OVERLAP_RATIO) return { covers: false, ratio, reason: "no_overlap" };

  const own = contentTokens(requirement.text);
  if (own.length > AMBIGUOUS_REQUIREMENT_TOKENS) return { covers: true, ratio };

  const context = contextTokens(requirement, siblings);
  if (context.length === 0) return { covers: true, ratio }; // Nothing to disambiguate against.

  const present = new Set(contentTokens(questionText));
  const anchored = context.some((token) => present.has(token));

  // The requirement's own word is in there, but nothing else from the sentence it came from.
  // That is a name-drop, not coverage.
  return anchored ? { covers: true, ratio } : { covers: false, ratio, reason: "name_drop" };
}

export interface TagGateResult {
  kept: string[];
  dropped: { id: string; reason: "no_overlap" | "name_drop" | "unknown_requirement" | "over_cap" }[];
}

/**
 * Trim a question's `requirement_ids` to the ones it actually earns.
 *
 * Runs on every question before the first coverage check, bulk and gap-fill alike. A requirement
 * that loses its last question goes straight back into the gap list, which is what the second
 * pass exists for.
 *
 * The cap is applied last and by descending overlap, so a question tagged with five ids keeps
 * the three it covers best rather than the three the model happened to list first.
 */
export function gateQuestionTags(
  question: { prompt: string; answerOutline?: string; requirementIds: readonly string[] },
  byId: ReadonlyMap<string, Requirement>,
): TagGateResult {
  // The outline counts as part of the question: a design question can name the requirement in
  // its answer points rather than in the prompt sentence.
  const text = `${question.prompt} ${question.answerOutline ?? ""}`;

  const siblings = [...byId.values()];
  const kept: { id: string; ratio: number }[] = [];
  const dropped: TagGateResult["dropped"] = [];

  for (const id of question.requirementIds) {
    const requirement = byId.get(id);
    if (requirement === undefined) {
      dropped.push({ id, reason: "unknown_requirement" });
      continue;
    }

    const verdict = coversRequirement(requirement, text, siblings);
    if (verdict.covers) kept.push({ id, ratio: verdict.ratio });
    else dropped.push({ id, reason: verdict.reason ?? "no_overlap" });
  }

  kept.sort((a, b) => b.ratio - a.ratio || a.id.localeCompare(b.id));
  for (const extra of kept.slice(MAX_REQUIREMENT_IDS_PER_QUESTION)) {
    dropped.push({ id: extra.id, reason: "over_cap" });
  }

  return {
    kept: kept.slice(0, MAX_REQUIREMENT_IDS_PER_QUESTION).map((entry) => entry.id),
    dropped,
  };
}

export interface GateInput {
  prompt: string;
  /**
   * Requirement ids the draft claims to cover, if it volunteered any. Gap fill does not ask for
   * these, so anything here is unsolicited and is checked against what we actually supplied —
   * it is how a hallucinated id from the bulk path gets caught.
   */
  claimedRequirementIds?: readonly string[];
  cluster: readonly Requirement[];
  existingQuestions: readonly InternalQuestion[];
}

export function acceptGapFill(input: GateInput): GateResult {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) return { accepted: false, reason: "empty" };

  if (input.claimedRequirementIds !== undefined) {
    const supplied = new Set(input.cluster.map((r) => r.id));
    for (const id of input.claimedRequirementIds) {
      if (!supplied.has(id)) return { accepted: false, reason: "unsolicited_requirement_id" };
    }
  }

  if (normalise(prompt).split(" ").filter(Boolean).length < MIN_PROMPT_TOKENS) {
    return { accepted: false, reason: "stub" };
  }

  // Weak models love returning a rephrase of the question they just produced.
  for (const existing of input.existingQuestions) {
    if (!existing.active) continue;
    if (jaccard(existing.prompt, prompt) >= MAX_DUPLICATE_SIMILARITY) {
      return { accepted: false, reason: "duplicate" };
    }
  }

  // One cluster member is enough — the cluster is coherent by construction, and a question need
  // not name all three. The same source-span anchoring applies, which is what rejects a question
  // about motivation offered as coverage for "Drive".
  let best: CoverageVerdict = { covers: false, ratio: 0, reason: "no_overlap" };
  for (const requirement of input.cluster) {
    const verdict = coversRequirement(requirement, prompt, input.cluster);
    if (verdict.covers) return { accepted: true };
    if (verdict.ratio > best.ratio) best = verdict;
  }

  return { accepted: false, reason: best.reason ?? "no_overlap" };
}
