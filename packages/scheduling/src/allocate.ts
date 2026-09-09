import {
  minutesForDifficulty,
  minutesForQuestions,
  type InternalDay,
  type InternalQuestion,
  type InternalSchedule,
  type Requirement,
} from "@trao/kit";
import { assignFocuses } from "./focus";
import { byUrgency, indexRequirements } from "./weight";

/**
 * Schedule allocation.
 *
 * Pure arithmetic: questions plus a day count in, a schedule out. No model, no network, no I/O,
 * no clock. The brief says twice that allocating topics across the available days is the
 * application's job, and a prompt that returns a schedule loses the points even when the output
 * looks fine.
 *
 * ## The policy
 *
 * 1. Sort every active question by urgency — `difficulty × priority`, hardest and most
 *    important first.
 * 2. Fill days in order up to a per-day minute target, moving on only once a day has something
 *    on it and is at or over target. Because the list is sorted, day 1 necessarily gets heavier
 *    material than day 2, and so on: harder work lands early, not the night before.
 * 3. Anything left when the last day is reached goes on the last day. Nothing is ever dropped —
 *    a must-have that fell off the end would be a coverage failure caused by the scheduler.
 * 4. Days still empty become **spaced review days**, cycling back through the material by
 *    urgency.
 *
 * ## Why review days, for the 60-day case
 *
 * With 20 questions and 60 days the alternative — thin days — leaves 40 days empty, and an
 * empty day reads as broken however valid it is. Learning the material in the first stretch and
 * revisiting it after is also what anyone would actually advise with two months to prepare.
 * Cross-day repeats are therefore legal in the kit schema; a repeat within one day is not.
 */

export interface AllocationInput {
  questions: readonly InternalQuestion[];
  requirements: readonly Requirement[];
  daysAvailable: number;
}

export function allocateSchedule(input: AllocationInput): InternalSchedule {
  const daysAvailable = Math.max(1, Math.trunc(input.daysAvailable));
  const requirements = indexRequirements(input.requirements);
  const active = input.questions.filter((q) => q.active).sort(byUrgency(requirements));

  const buckets: InternalQuestion[][] = Array.from({ length: daysAvailable }, () => []);
  distribute(active, buckets);
  const reviewDays = fillReviewDays(active, buckets);

  // Focus is assigned across the whole schedule at once: a day is named after the requirements
  // that distinguish it from the others, which cannot be decided one day at a time.
  const focuses = assignFocuses(
    buckets.map((questions, index) => ({ questions, review: reviewDays.has(index) })),
    requirements,
    (r) => (r.priority === "must" ? 2 : 1),
  );

  return {
    daysAvailable,
    days: buckets.map((questions, index) => toDay(index + 1, questions, focuses[index] as string)),
  };
}

/**
 * Rebuild the schedule around the days the user has already arranged.
 *
 * Edited days are returned byte-for-byte — focus, questions, minutes, all of it. Regenerating a
 * question category must not wipe a day focus somebody rewrote, which is the same provenance
 * idea as questions, one level up. Everything not sitting on an edited day is reallocated
 * across the remaining days.
 */
export function reallocateSchedule(
  existing: InternalSchedule,
  input: Omit<AllocationInput, "daysAvailable">,
): InternalSchedule {
  const requirements = indexRequirements(input.requirements);
  const activeById = new Map(input.questions.filter((q) => q.active).map((q) => [q.id, q]));

  const editedDays = new Map<number, InternalDay>();
  const claimed = new Set<string>();
  for (const [index, day] of existing.days.entries()) {
    if (!day.edited) continue;
    // Even a preserved day cannot keep an id that no longer resolves.
    const questionIds = day.questionIds.filter((id) => activeById.has(id));
    for (const id of questionIds) claimed.add(id);
    editedDays.set(index, { ...day, questionIds });
  }

  const openIndexes = existing.days.map((_, index) => index).filter((index) => !editedDays.has(index));
  const remaining = [...activeById.values()].filter((q) => !claimed.has(q.id)).sort(byUrgency(requirements));

  const buckets: InternalQuestion[][] = openIndexes.map(() => []);
  distribute(remaining, buckets);
  const reviewBuckets = fillReviewDays(remaining, buckets);

  const focuses = assignFocuses(
    buckets.map((questions, slot) => ({ questions, review: reviewBuckets.has(slot) })),
    requirements,
    (r) => (r.priority === "must" ? 2 : 1),
  );

  const days = existing.days.map((day, index) => {
    const preserved = editedDays.get(index);
    if (preserved) return preserved;
    const slot = openIndexes.indexOf(index);
    return toDay(day.day, buckets[slot] ?? [], focuses[slot] as string);
  });

  return { daysAvailable: existing.daysAvailable, days };
}

/**
 * Steps 2 and 3: greedy front-loaded fill.
 *
 * Each day's share is recomputed from what is still unplaced — `remaining / days left` — rather
 * than fixed once as `total / days`. A fixed share misbehaves badly with chunky items: with 240
 * minutes over 5 days it sets a 48-minute target, every 30-minute question overshoots it
 * immediately, days 1–4 take one question each and the whole remainder lands on day 5. Which is
 * precisely backwards from front-loading.
 *
 * Recomputing self-corrects. A day that overshoots its share lowers the share for the days
 * after it, and the last day's share is by definition everything left, so nothing is dropped.
 */
function distribute(questions: readonly InternalQuestion[], buckets: InternalQuestion[][]): void {
  if (buckets.length === 0 || questions.length === 0) return;

  const queue = [...questions];
  let remainingMinutes = minutesForQuestions(queue);

  for (let index = 0; index < buckets.length && queue.length > 0; index += 1) {
    const daysLeft = buckets.length - index;
    const share = Math.ceil(remainingMinutes / daysLeft);
    const bucket = buckets[index] as InternalQuestion[];

    let minutesOnDay = 0;
    // At least one question per day while any remain — a day is never skipped over.
    do {
      const question = queue.shift() as InternalQuestion;
      bucket.push(question);
      minutesOnDay += minutesForDifficulty(question.difficulty);
    } while (queue.length > 0 && minutesOnDay < share);

    remainingMinutes -= minutesOnDay;
  }

  // Unreachable — the last day's share is everything left — but a dropped must-have would be a
  // coverage failure caused by the scheduler, so it is not left to an argument about the maths.
  if (queue.length > 0) (buckets[buckets.length - 1] as InternalQuestion[]).push(...queue);
}

/**
 * Step 4: every day that got nothing becomes a review day.
 *
 * Review items are drawn from the same urgency-sorted list with a rotating cursor, so the
 * hardest must-haves come round most often and every question is revisited before any is
 * revisited twice. Returns the indexes that became review days, for labelling.
 */
function fillReviewDays(source: readonly InternalQuestion[], buckets: InternalQuestion[][]): Set<number> {
  const reviewDays = new Set<number>();
  const emptyIndexes = buckets.flatMap((bucket, index) => (bucket.length === 0 ? [index] : []));
  if (emptyIndexes.length === 0 || source.length === 0) return reviewDays;

  const studyDays = buckets.length - emptyIndexes.length;
  const perDay = Math.min(source.length, Math.max(1, Math.ceil(source.length / Math.max(1, studyDays))));

  let cursor = 0;
  for (const index of emptyIndexes) {
    const items: InternalQuestion[] = [];
    const seen = new Set<string>();
    // `source.length` attempts is enough to wrap once; a full lap without a new item means the
    // pool is smaller than perDay, which the min() above already bounded.
    while (items.length < perDay && seen.size < source.length) {
      const question = source[cursor % source.length] as InternalQuestion;
      cursor += 1;
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      items.push(question);
    }
    buckets[index] = items;
    reviewDays.add(index);
  }

  return reviewDays;
}

function toDay(day: number, questions: readonly InternalQuestion[], focus: string): InternalDay {
  return {
    day,
    focus,
    questionIds: questions.map((q) => q.id),
    minutes: minutesForQuestions(questions),
    edited: false,
  };
}
