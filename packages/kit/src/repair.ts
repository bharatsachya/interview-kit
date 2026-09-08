import { minutesForQuestions } from "./minutes";
import type { InternalQuestion, InternalSchedule } from "./types";

/**
 * Schedule repair.
 *
 * Runs at the serialize boundary — from both projections, never from a write path and never
 * from a background job. Writes stay dumb: the regenerate endpoint swaps questions and saves,
 * with no integrity logic anywhere near it.
 *
 * Not a background job because batch mode generates and exits in about twelve minutes so a
 * cron never gets a turn, the demo would show a visibly broken schedule in the meantime, and
 * free hosts sleep. It is a set intersection over an in-memory document — microseconds.
 * Deferring it buys nothing and opens a window where the data is wrong.
 *
 * Repair is deliberately NOT re-allocation. Re-running allocation would recompute day focus
 * and reshuffle questions, which would wipe the days a user edited — the exact thing the
 * `edited` flag exists to prevent. Repair does the minimum that restores integrity:
 *
 *   1. Drop question ids that are archived or no longer exist.
 *   2. Drop a repeat within a single day.
 *   3. Place active questions that appear on no day at all.
 *   4. Recompute each day's minutes, because minutes is derived from membership.
 *
 * Step 2 is within a day only. A question appearing on two different days is deliberate — the
 * 60-day schedule policy is spaced review, so early material is meant to come back later.
 *
 * That is why it lives here rather than in `scheduling`: it is document integrity, it must not
 * know the allocation policy, and both projections in this package have to call it.
 */
export function repairSchedule(schedule: InternalSchedule, questions: readonly InternalQuestion[]): InternalSchedule {
  const activeById = new Map(questions.filter((q) => q.active).map((q) => [q.id, q]));

  const scheduled = new Set<string>();
  const days = schedule.days.map((day) => {
    const questionIds: string[] = [];
    const onThisDay = new Set<string>();
    for (const id of day.questionIds) {
      // Step 1: alive. Step 2: not already listed on this same day.
      if (!activeById.has(id) || onThisDay.has(id)) continue;
      onThisDay.add(id);
      scheduled.add(id);
      questionIds.push(id);
    }
    return { ...day, questionIds };
  });

  // Step 3. A question the user added by hand, or one whose day was deleted, has nowhere to be.
  // Leaving it out would hide it from the schedule while it still shows in the question bank.
  const unplaced = questions.filter((q) => q.active && !scheduled.has(q.id)).sort((a, b) => a.order - b.order);

  for (const question of unplaced) {
    const target = lightestDay(days, activeById);
    if (!target) break; // No days at all — nothing to place into. Validation reports it.
    target.questionIds.push(question.id);
  }

  // Step 4.
  for (const day of days) {
    day.minutes = minutesForQuestions(day.questionIds.map((id) => activeById.get(id)).filter(isPresent));
  }

  return { ...schedule, days };
}

/**
 * Where an orphan question goes: the day with the least work on it, earliest day breaking a tie.
 *
 * Days the user has edited are avoided while any unedited day exists — dropping a question into
 * somebody's hand-arranged day is the same kind of clobbering the `edited` flag guards against
 * elsewhere. If every day is edited, the question still gets placed: an unscheduled question is
 * worse than a slightly disturbed day.
 */
function lightestDay(
  days: { day: number; questionIds: string[]; edited: boolean }[],
  activeById: ReadonlyMap<string, InternalQuestion>,
): { day: number; questionIds: string[] } | undefined {
  if (days.length === 0) return undefined;
  const unedited = days.filter((d) => !d.edited);
  const candidates = unedited.length > 0 ? unedited : days;

  return candidates.reduce((best, day) => {
    const bestMinutes = minutesForQuestions(best.questionIds.map((id) => activeById.get(id)).filter(isPresent));
    const dayMinutes = minutesForQuestions(day.questionIds.map((id) => activeById.get(id)).filter(isPresent));
    if (dayMinutes < bestMinutes) return day;
    if (dayMinutes > bestMinutes) return best;
    return day.day < best.day ? day : best;
  });
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
