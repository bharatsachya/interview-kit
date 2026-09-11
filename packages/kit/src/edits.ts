import type { IdGenerator } from "@trao/contracts";
import type {
  CompanyBrief,
  Difficulty,
  InternalDay,
  InternalFlashcard,
  InternalKit,
  InternalQuestion,
  QuestionCategory,
} from "./types";
import { commit, type MutationOptions } from "./version";

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
  options?: MutationOptions,
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

  return commit(kit, options, { questions: [...questions, ...added], flashcards });
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
export function deleteQuestion(kit: InternalKit, questionId: string, options?: MutationOptions): InternalKit {
  // Every card derived from it goes too, whatever its origin.
  //
  // Different from a regeneration on purpose. A regeneration is the machine taking back its own
  // work, so it spares anything the user claimed. This is the user deleting a question outright,
  // and a card that only exists to quiz you on a question you just removed has nothing left
  // behind it — keeping it because it happens to be pinned would leave an orphan on screen.
  return commit(kit, options, {
    questions: kit.questions.map((q) => (q.id === questionId ? { ...q, active: false } : q)),
    flashcards: kit.flashcards.map((f) => (f.questionId === questionId ? { ...f, active: false } : f)),
  });
}

export function deleteFlashcard(kit: InternalKit, flashcardId: string, options?: MutationOptions): InternalKit {
  return commit(kit, options, {
    flashcards: kit.flashcards.map((f) => (f.id === flashcardId ? { ...f, active: false } : f)),
  });
}

/** @deprecated Names kept so existing callers keep compiling. Prefer the `delete*` pair. */
export const archiveQuestion = deleteQuestion;
export const archiveFlashcard = deleteFlashcard;

/**
 * The three fields the builder may change on a question.
 *
 * `requirementIds` is deliberately absent. Coverage is computed from it, and letting the editor
 * retag a question by hand would let someone close a coverage gap by relabelling rather than by
 * answering it — the check would go green while the kit stayed exactly as thin. `category` is
 * absent too: moving a question is `moveQuestion`, which has ordering to maintain.
 */
export type QuestionPatch = Partial<Pick<InternalQuestion, "prompt" | "answerOutline" | "difficulty">>;

/**
 * An inline edit in the builder.
 *
 * Promotes `generated` and `fallback` to `edited`, which is what makes the question survive a
 * later regeneration of its category. `manual` stays `manual` — the user wrote it, and it was
 * already safe. Editing does not pin: "I changed this" and "keep this" are different intents,
 * and conflating them would silently opt the user out of regenerating their own edits away.
 */
export function editQuestion(
  kit: InternalKit,
  questionId: string,
  patch: QuestionPatch,
  options?: MutationOptions,
): InternalKit {
  return commit(kit, options, {
    questions: kit.questions.map((q) =>
      q.id === questionId ? { ...q, ...patch, origin: claimed(q.origin) } : q,
    ),
  });
}

export type FlashcardPatch = Partial<Pick<InternalFlashcard, "front" | "back" | "requirementIds">>;

export function editFlashcard(
  kit: InternalKit,
  flashcardId: string,
  patch: FlashcardPatch,
  options?: MutationOptions,
): InternalKit {
  return commit(kit, options, {
    flashcards: kit.flashcards.map((f) =>
      f.id === flashcardId ? { ...f, ...patch, origin: claimed(f.origin) } : f,
    ),
  });
}

/**
 * Pinning flips one flag and nothing else.
 *
 * `origin` stays where it was on purpose. "Keep this" and "I wrote this" are separate claims —
 * promoting a generated question to `edited` because it was pinned would mean unpinning it no
 * longer put it back in reach of a regeneration, and the user would have no way to undo.
 */
export function pinQuestion(
  kit: InternalKit,
  questionId: string,
  pinned: boolean,
  options?: MutationOptions,
): InternalKit {
  return commit(kit, options, {
    questions: kit.questions.map((q) => (q.id === questionId ? { ...q, pinned } : q)),
  });
}

/** @deprecated Kept so existing callers keep compiling. Prefer `pinQuestion`. */
export const setQuestionPinned = pinQuestion;

/**
 * A question the user wrote, and the card that goes with it.
 *
 * Both ids come from the generator rather than the caller: an id chosen outside this module is
 * an id that can collide with one already archived, and a reused id is the one way a soft delete
 * can still produce a dangling reference.
 *
 * The card is created here rather than left to a later derive pass because the pair is the unit
 * the user thinks in. A manual question that produced no card would quietly be the only question
 * in the kit you cannot revise from the deck.
 */
export function addQuestion(
  kit: InternalKit,
  draft: QuestionDraft,
  ids: IdGenerator,
  options?: MutationOptions,
): InternalKit {
  const question: InternalQuestion = {
    id: ids.next("q"),
    category: draft.category,
    prompt: draft.prompt,
    answerOutline: draft.answerOutline,
    difficulty: draft.difficulty,
    requirementIds: [...draft.requirementIds],
    origin: "manual",
    pinned: false,
    active: true,
    order: maxOrder(kit.questions.filter((q) => q.category === draft.category)) + 1,
  };

  const card: InternalFlashcard = {
    id: ids.next("f"),
    front: draft.prompt,
    back: draft.answerOutline,
    requirementIds: [...draft.requirementIds],
    questionId: question.id,
    // Manual, not generated: it came from a question the user wrote, and a regeneration of the
    // category must not sweep it up.
    origin: "manual",
    pinned: false,
    active: true,
    order: maxOrder(kit.flashcards) + 1,
  };

  return commit(kit, options, {
    questions: [...kit.questions, question],
    flashcards: [...kit.flashcards, card],
  });
}

export interface QuestionDraft {
  category: QuestionCategory;
  prompt: string;
  answerOutline: string;
  difficulty: Difficulty;
  requirementIds: string[];
}

/** @deprecated Kept so existing callers keep compiling. Prefer `addQuestion`. */
export function addManualQuestion(
  kit: InternalKit,
  category: QuestionCategory,
  question: NewQuestion,
): InternalKit {
  const order = maxOrder(kit.questions.filter((q) => q.category === category)) + 1;
  return commit(kit, undefined, {
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
  });
}

/** A card the user wrote, standing on its own rather than derived from a question. */
export function addFlashcard(
  kit: InternalKit,
  draft: FlashcardDraft,
  ids: IdGenerator,
  options?: MutationOptions,
): InternalKit {
  return commit(kit, options, {
    flashcards: [
      ...kit.flashcards,
      {
        id: ids.next("f"),
        front: draft.front,
        back: draft.back,
        requirementIds: [...(draft.requirementIds ?? [])],
        // Nothing behind it, so nothing can archive it out from under the user.
        questionId: null,
        origin: "manual",
        pinned: false,
        active: true,
        order: maxOrder(kit.flashcards) + 1,
      },
    ],
  });
}

export interface FlashcardDraft {
  front: string;
  back: string;
  requirementIds?: string[];
}

/**
 * Move a question to another category.
 *
 * Its requirement ids travel with it untouched — the category says what kind of question it is,
 * the requirement ids say what it covers, and moving a system-design question into behavioural
 * does not change which requirement it answers. Coverage is therefore unaffected by a move,
 * which is the property that makes this safe to expose in the builder at all.
 *
 * It lands at the end of the new category rather than at its old index: the old number belongs
 * to a different list and would drop it in an arbitrary place in this one.
 */
export function moveQuestion(
  kit: InternalKit,
  questionId: string,
  toCategory: QuestionCategory,
  options?: MutationOptions,
): InternalKit {
  const order = maxOrder(kit.questions.filter((q) => q.category === toCategory)) + 1;
  return commit(kit, options, {
    questions: kit.questions.map((q) =>
      q.id === questionId ? { ...q, category: toCategory, order, origin: claimed(q.origin) } : q,
    ),
  });
}

/**
 * Reorder a category from a list of ids.
 *
 * The list is authoritative for what is in it and silent about everything else. Ids the caller
 * did not mention keep their relative order and follow the listed ones — a drag-and-drop that
 * sent only the visible window must not reshuffle what was scrolled off, and a list that has
 * gone stale must not drop the question somebody else just added.
 *
 * Archived questions are skipped: they hold an order so a restore would have somewhere to go,
 * but they are not in the list the user was looking at.
 */
export function reorderQuestions(
  kit: InternalKit,
  category: QuestionCategory,
  ids: readonly string[],
  options?: MutationOptions,
): InternalKit {
  const inCategory = kit.questions.filter((q) => q.category === category && q.active);
  const listed = ids.filter((id) => inCategory.some((q) => q.id === id));
  const rest = inCategory
    .filter((q) => !listed.includes(q.id))
    .sort((a, b) => a.order - b.order)
    .map((q) => q.id);

  const position = new Map([...listed, ...rest].map((id, index) => [id, index]));

  return commit(kit, options, {
    questions: kit.questions.map((q) =>
      position.has(q.id) ? { ...q, order: position.get(q.id) as number } : q,
    ),
  });
}

/**
 * An edit to one day of the schedule.
 *
 * `edited: true` is the whole point: allocation is arithmetic and recomputes freely, but it must
 * step around any day a person has rewritten. Without the flag, regenerating a category would
 * silently restore the focus line the user replaced.
 */
export function editScheduleDay(
  kit: InternalKit,
  day: number,
  patch: SchedulePatch,
  options?: MutationOptions,
): InternalKit {
  return commit(kit, options, {
    schedule: {
      ...kit.schedule,
      days: kit.schedule.days.map((d) => (d.day === day ? { ...d, ...patch, edited: true } : d)),
    },
  });
}

export type SchedulePatch = Partial<Pick<InternalDay, "focus" | "minutes" | "questionIds">>;

/** An edit to the company brief. Same claim an edited question makes, on the prose. */
export function editBrief(kit: InternalKit, patch: BriefPatch, options?: MutationOptions): InternalKit {
  return commit(kit, options, {
    companyBrief: { ...kit.companyBrief, ...patch, origin: claimed(kit.companyBrief.origin), edited: true },
  });
}

export type BriefPatch = Partial<Pick<CompanyBrief, "summary" | "whatTheyDo" | "hiringProcess">>;

function maxOrder(items: readonly { order: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), -1);
}

/**
 * What an edit does to provenance.
 *
 * Everything the machine produced becomes the user's. `manual` is already a stronger claim than
 * `edited` — both survive a regeneration, but `manual` also records that no model ever wrote
 * this — so editing your own question does not quietly demote it.
 */
function claimed(origin: InternalQuestion["origin"]): InternalQuestion["origin"] {
  return origin === "manual" ? "manual" : "edited";
}
