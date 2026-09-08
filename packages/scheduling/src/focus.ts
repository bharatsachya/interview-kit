import type { InternalQuestion, QuestionCategory } from "@trao/kit";

/**
 * Day focus, derived in code.
 *
 * The model never writes these. A focus line is a label for whatever the arithmetic already put
 * on the day — asking a model for it would mean the label and the contents could disagree, and
 * it would cost a call per day for something a lookup table does exactly.
 */

const CATEGORY_FOCUS: Readonly<Record<QuestionCategory, string>> = {
  technical: "Technical depth",
  behavioural: "Behavioural stories",
  "system-design": "System design",
  "company-fit": "Company fit",
};

/** Shown when the kit produced no questions at all. Honest rather than blank. */
export const EMPTY_DAY_FOCUS = "Nothing scheduled — the job description produced no questions";

export const MIXED_FOCUS = "Mixed practice";

export function focusFor(questions: readonly InternalQuestion[], options: { review?: boolean } = {}): string {
  if (questions.length === 0) return EMPTY_DAY_FOCUS;

  const counts = new Map<QuestionCategory, number>();
  for (const question of questions) {
    counts.set(question.category, (counts.get(question.category) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [topCategory, topCount] = ranked[0] as [QuestionCategory, number];
  const runnerUpCount = ranked[1]?.[1] ?? 0;

  // A genuine tie has no dominant subject, and naming one of the two would misdescribe the day.
  const label = topCount === runnerUpCount ? MIXED_FOCUS : (CATEGORY_FOCUS[topCategory] ?? MIXED_FOCUS);

  return options.review === true ? `Review — ${lowerFirst(label)}` : label;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
