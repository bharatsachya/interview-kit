import type { InternalQuestion, InternalSchedule } from "@trao/kit";
import { Frame } from "@/components/industry/frame";
import { CategoryMark } from "@/components/industry/marks";

/**
 * Days are rows, not a calendar grid.
 *
 * Minutes are the honest unit and the count comes from the questions actually in the block —
 * the field is derived by @trao/kit from the shared difficulty table, never typed here, so the
 * day and its contents cannot drift apart.
 *
 * The label counts down to the interview: with four days available, the first block is D-4 and
 * the last is D-1. A kit is generated before any of it is done, so the first day is marked
 * "start here" rather than "today" — the document carries no notion of progress, and inventing
 * one in the view would be a lie the data cannot back.
 */
export function ScheduleList({
  schedule,
  questions,
}: {
  schedule: InternalSchedule;
  questions: readonly InternalQuestion[];
}) {
  const byId = new Map(questions.map((question) => [question.id, question]));

  if (schedule.days.length === 0) {
    return (
      <Frame empty className="p-4" marks={false}>
        <p className="max-w-read text-sm">
          {schedule.daysAvailable <= 1
            ? "One day left, so there is no schedule to make. Work the questions hardest-first."
            : "No schedule yet. The questions and cards are all here — only the day-by-day plan is missing."}
        </p>
      </Frame>
    );
  }

  return (
    <ol className="flex list-none flex-col gap-4">
      {schedule.days.map((day, index) => {
        const dayQuestions = day.questionIds
          .map((id) => byId.get(id))
          .filter((question) => question !== undefined);
        const first = index === 0;

        return (
          <li key={day.day}>
            <Frame className={`flex flex-col gap-3 p-4 ${first ? "bg-mint" : ""}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-head text-xs tracking-widest uppercase tabular-nums">
                  D-{schedule.daysAvailable - day.day + 1}
                </span>
                {first ? (
                  <span className="font-head text-teal-800 text-xs tracking-widest uppercase">
                    Start here
                  </span>
                ) : null}
                <span className="ml-auto text-xs font-medium tabular-nums opacity-55">
                  {day.minutes} MIN
                </span>
              </div>

              <p className="text-lg leading-snug">
                {day.focus}
                {day.edited ? (
                  <span className="ml-3 align-middle text-xs font-medium opacity-55">Edited</span>
                ) : null}
              </p>

              {dayQuestions.length > 0 ? (
                <>
                  <ul className="flex list-none flex-wrap gap-2">
                    {dayQuestions.map((question) => (
                      <li key={question.id}>
                        <CategoryMark category={question.category} />
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs font-medium tabular-nums opacity-55">
                    {dayQuestions.length} {dayQuestions.length === 1 ? "question" : "questions"}
                  </p>
                </>
              ) : (
                <p className="text-sm opacity-55">No block. Rest day.</p>
              )}
            </Frame>
          </li>
        );
      })}
    </ol>
  );
}
