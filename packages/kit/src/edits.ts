import type {
  Difficulty,
  InternalFlashcard,
  InternalKit,
  InternalQuestion,
  QuestionCategory,
} from "./types";

/**
 * State transitions on a kit. All pure — take a kit, return a new one, touch nothing else.
 *
 * This is the 15-point state problem. The rule underneath every function here: a regeneration
 * the user asked for may only take back what the machine put there and the user has not
 * claimed. Everything else survives.
 */

/**
 * Regenerate one question category.
 *
 * Archives only `origin === "generated" && !pinned` questions in that category. Edited, manual,
 * pinned and fallback questions survive, as does every other category. Flashcards derived from
 * an archived question are archived with it under the same rule, so the pair cannot drift apart
 * — but a flashcard the user edited or pinned stays, even when its source question goes.
 *
 * Nothing is deleted and no id is reused, so no reference can dangle in storage. Repair at the
 * serialize boundary is what removes the archived ids from the schedule.
 */
export function regenerateCategory(
  kit: InternalKit,
  category: QuestionCategory,
  replacements: readonly NewQuestion[],
): InternalKit {
  const isDisposable = (q: InternalQuestion): boolean =>
    q.category === category && q.origin === "generated" && !q.pinned;

  const archivedQuestionIds = new Set(kit.questions.filter((q) => q.active && isDisposable(q)).map((q) => q.id));

  const questions = kit.questions.map((q) => (archivedQuestionIds.has(q.id) ? { ...q, active: false } : q));

  const flashcards = kit.flashcards.map((f) =>
    f.active && f.questionId !== null && archivedQuestionIds.has(f.questionId) && f.origin === "generated" && !f.pinned
      ? { ...f, active: false }
      : f,
  );

  let nextOrder = maxOrder(questions.filter((q) => q.category === category)) + 1;
  const added: InternalQuestion[] = replacements.map((q) => ({
    id: q.id,
    category,
    prompt: q.prompt,
    answerOutline: q.answerOutline,
    difficulty: q.difficulty,
    requirementIds: [...q.requirementIds],
    origin: q.origin ?? "generated",
    pinned: false,
    active: true,
    order: nextOrder++,
  }));

  return { ...kit, questions: [...questions, ...added], flashcards };
}

export interface NewQuestion {
  id: string;
  prompt: string;
  answerOutline: string;
  difficulty: Difficulty;
  requirementIds: string[];
  /** Defaults to "generated". Coverage fallback questions pass "fallback". */
  origin?: InternalQuestion["origin"];
}

/**
 * Soft delete. The item stays in storage forever so its id can never dangle, and disappears
 * from every projection immediately. There is no restore: because storage keeps the id on its
 * day, restoring would silently return a question to a day the user has since rearranged.
 */
export function archiveQuestion(kit: InternalKit, questionId: string): InternalKit {
  return {
    ...kit,
    questions: kit.questions.map((q) => (q.id === questionId ? { ...q, active: false } : q)),
    // A derived card whose question is gone has nothing behind it. One the user made their own
    // does, so it stays.
    flashcards: kit.flashcards.map((f) =>
      f.questionId === questionId && f.origin === "generated" && !f.pinned ? { ...f, active: false } : f,
    ),
  };
}

export function archiveFlashcard(kit: InternalKit, flashcardId: string): InternalKit {
  return {
    ...kit,
    flashcards: kit.flashcards.map((f) => (f.id === flashcardId ? { ...f, active: false } : f)),
  };
}

export type QuestionPatch = Partial<
  Pick<InternalQuestion, "prompt" | "answerOutline" | "difficulty" | "requirementIds" | "category">
>;

/**
 * An inline edit in the builder.
 *
 * Promotes `generated` and `fallback` to `edited`, which is what makes the question survive a
 * later regeneration of its category. `manual` stays `manual` — the user wrote it, and it was
 * already safe. Editing does not pin: "I changed this" and "keep this" are different intents,
 * and conflating them would silently opt the user out of regenerating their own edits away.
 */
export function editQuestion(kit: InternalKit, questionId: string, patch: QuestionPatch): InternalKit {
  return {
    ...kit,
    questions: kit.questions.map((q) =>
      q.id === questionId ? { ...q, ...patch, origin: q.origin === "manual" ? "manual" : "edited" } : q,
    ),
  };
}

export type FlashcardPatch = Partial<Pick<InternalFlashcard, "front" | "back" | "requirementIds">>;

export function editFlashcard(kit: InternalKit, flashcardId: string, patch: FlashcardPatch): InternalKit {
  return {
    ...kit,
    flashcards: kit.flashcards.map((f) =>
      f.id === flashcardId ? { ...f, ...patch, origin: f.origin === "manual" ? "manual" : "edited" } : f,
    ),
  };
}

export function setQuestionPinned(kit: InternalKit, questionId: string, pinned: boolean): InternalKit {
  return {
    ...kit,
    questions: kit.questions.map((q) => (q.id === questionId ? { ...q, pinned } : q)),
  };
}

/** A question the user wrote. Never touched by a regeneration. */
export function addManualQuestion(kit: InternalKit, category: QuestionCategory, question: NewQuestion): InternalKit {
  const order = maxOrder(kit.questions.filter((q) => q.category === category)) + 1;
  return {
    ...kit,
    questions: [
      ...kit.questions,
      {
        id: question.id,
        category,
        prompt: question.prompt,
        answerOutline: question.answerOutline,
        difficulty: question.difficulty,
        requirementIds: [...question.requirementIds],
        origin: "manual",
        pinned: false,
        active: true,
        order,
      },
    ],
  };
}

function maxOrder(items: readonly { order: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), -1);
}
