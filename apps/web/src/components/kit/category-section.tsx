import type { InternalQuestion, QuestionCategory } from "@trao/kit";
import { minutesForQuestions } from "@trao/kit";
import { Frame } from "@/components/industry/frame";
import { CategoryMark } from "@/components/industry/marks";
import { QuestionCard } from "@/components/kit/question-card";
import { CATEGORY_META } from "@/lib/categories";

/**
 * Groups the bank and owns its own regenerate — regeneration is always section-scoped, and
 * says which section before it starts.
 *
 * An empty category is drawn dashed and left in place rather than hidden: the four categories
 * are a checklist, and a gap is worth seeing.
 */
export function CategorySection({
  category,
  questions,
}: {
  category: QuestionCategory;
  questions: readonly InternalQuestion[];
}) {
  const meta = CATEGORY_META[category];
  const minutes = minutesForQuestions(questions);

  return (
    <section aria-labelledby={`category-${category}`} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <CategoryMark category={category} className="self-center" />
        <h3 id={`category-${category}`} className="text-2xl">
          {meta.label}
        </h3>
        <span className="ml-auto text-xs font-medium tabular-nums opacity-55">
          {questions.length} · {minutes} MIN
        </span>
      </div>

      {questions.length === 0 ? (
        <Frame empty className="p-4" marks={false}>
          <p className="max-w-read text-sm">
            Nothing in {meta.label} yet. The description didn&rsquo;t give us anything to ask about
            here, so we didn&rsquo;t invent any.
          </p>
        </Frame>
      ) : (
        <ul className="flex list-none flex-col gap-6">
          {questions.map((question) => (
            <li key={question.id}>
              <QuestionCard question={question} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
