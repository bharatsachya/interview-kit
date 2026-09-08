import type { Difficulty, QuestionCategory } from "@trao/kit";
import { CATEGORY_META } from "@/lib/categories";

/**
 * The category square: one colour plus the letter, hairline-framed in ink.
 *
 * The letter is not decoration. It is what makes the category readable in greyscale, at the
 * size the drag ghost uses, and to anyone who does not separate teal from mint.
 */
export function CategoryMark({
  category,
  className = "",
}: {
  category: QuestionCategory;
  className?: string;
}) {
  const meta = CATEGORY_META[category];
  return (
    <span
      className={`border-ink font-head inline-flex size-6 shrink-0 items-center justify-center border text-xs leading-none ${meta.markClass} ${className}`}
      title={meta.label}
    >
      <span aria-hidden>{meta.letter}</span>
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

const DIFFICULTY_LABEL: Readonly<Record<Difficulty, string>> = {
  1: "Warm-up",
  2: "Moderate",
  3: "Hard",
};

/**
 * Difficulty is a quantity, so it is counted — ink ticks, never a colour scale. Always paired
 * with the D1/D2/D3 label so the value is printed as well as drawn.
 */
export function DifficultyTicks({ difficulty }: { difficulty: Difficulty }) {
  return (
    <span className="inline-flex items-center gap-2" aria-label={`Difficulty ${difficulty} of 3`}>
      <span aria-hidden className="inline-flex items-center gap-1">
        {[1, 2, 3].map((step) => (
          <span
            key={step}
            className={`border-ink h-3 w-1 border ${step <= difficulty ? "bg-ink" : "bg-transparent"}`}
          />
        ))}
      </span>
      <span aria-hidden className="text-xs font-medium tabular-nums">
        D{difficulty} · {DIFFICULTY_LABEL[difficulty].toUpperCase()}
      </span>
    </span>
  );
}

export type Confidence = 1 | 2 | 3;

const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>> = {
  1: "Shaky — resurfaces first",
  2: "Getting there — one more pass",
  3: "Solid — parked",
};

/**
 * Empty, hatched, solid. Reads as "how filled in is this", not as pass/fail — a shaky card
 * four days out is information, not a failure, so it never borrows the red.
 */
export function ConfidenceMark({ level, className = "" }: { level: Confidence; className?: string }) {
  const fill = level === 3 ? "bg-ink" : level === 2 ? "hatch" : "bg-transparent";
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span aria-hidden className={`border-ink size-4 border ${fill}`} />
      <span className="text-xs font-medium">{CONFIDENCE_LABEL[level]}</span>
    </span>
  );
}
