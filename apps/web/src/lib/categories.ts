import type { QuestionCategory } from "@trao/kit";

/**
 * One colour each, hairline-framed in ink so they hold on the near-white ground. The square
 * also carries the letter, so the category survives greyscale, small sizes and the drag ghost.
 *
 * Order matches QUESTION_CATEGORIES in @trao/kit — the four categories are a checklist, and
 * the UI renders all four even when one is empty.
 */
export const CATEGORY_META: Readonly<
  Record<QuestionCategory, { letter: string; label: string; markClass: string }>
> = {
  technical: { letter: "T", label: "Technical", markClass: "bg-teal-300 text-ink" },
  behavioural: { letter: "B", label: "Behavioural", markClass: "bg-teal-200 text-ink" },
  "system-design": { letter: "S", label: "System design", markClass: "bg-ink text-paper" },
  "company-fit": { letter: "C", label: "Company fit", markClass: "bg-paper text-ink" },
};
