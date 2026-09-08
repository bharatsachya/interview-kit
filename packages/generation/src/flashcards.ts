import type { IdGenerator } from "@trao/contracts";
import type { InternalFlashcard, InternalQuestion } from "@trao/kit";

/**
 * Flashcards, derived. Zero model calls.
 *
 * Front from the question prompt, back from the answer outline, requirement ids carried over.
 * This costs nothing, guarantees the cards cover exactly what the questions cover, and keeps the
 * quota for extraction — which is worth 20 points, where this is worth none on its own.
 *
 * Practice mode is scored and runs on these, so the front has to read as a prompt rather than a
 * truncated paragraph.
 */

/** A question with no outline has no back. A card with an empty answer is worse than no card. */
export function deriveFlashcards(
  questions: readonly InternalQuestion[],
  ids: IdGenerator,
): InternalFlashcard[] {
  const cards: InternalFlashcard[] = [];
  let order = 0;

  for (const question of questions) {
    if (!question.active) continue;

    const back = question.answerOutline.trim();
    // Coverage fallback questions carry no outline by design. They stay in the question bank and
    // on the schedule; they just do not become cards.
    if (back.length === 0) continue;

    cards.push({
      id: ids.next("f"),
      front: frontFor(question.prompt),
      back,
      requirementIds: [...question.requirementIds],
      questionId: question.id,
      origin: "generated",
      pinned: false,
      active: true,
      order: order++,
    });
  }

  return cards;
}

/**
 * The prompt, or its first question if it is a paragraph with one buried in it.
 *
 * Long prompts are common — "Our ingest pipeline drops writes on restart. Walk me through how
 * you would fix it. What would you measure?" A card fronted with all three sentences is a wall;
 * one fronted with a truncation is worse.
 */
const MAX_FRONT_CHARS = 220;

export function frontFor(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_FRONT_CHARS) return trimmed;

  const sentences = trimmed.match(/[^.!?]+[.!?]+/g) ?? [];
  const question = sentences.find((sentence) => sentence.trim().endsWith("?"));
  if (question !== undefined && question.trim().length <= MAX_FRONT_CHARS) return question.trim();

  // No question mark anywhere: fall back to the last complete sentence that fits, which is
  // usually the ask. Never a mid-word cut.
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const candidate = sentences[i]?.trim() ?? "";
    if (candidate.length > 0 && candidate.length <= MAX_FRONT_CHARS) return candidate;
  }

  return `${trimmed.slice(0, trimmed.lastIndexOf(" ", MAX_FRONT_CHARS))}…`;
}
