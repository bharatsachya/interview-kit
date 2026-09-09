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
 * The card front: the prompt's first question, or the whole prompt.
 *
 * Never a truncation. A card fronted with "Our ingest pipeline buffers in memory and…" is not a
 * prompt, it is a fragment with an ellipsis, and practice mode is scored on these being readable.
 * So the rule is a sentence boundary or nothing: if the prompt opens with a question, that
 * question is the front; otherwise the whole prompt is, however long.
 *
 * Long is a lesser fault than mangled. A three-sentence front is awkward to read; a front cut at
 * "and…" looks like the generator broke.
 */
export function frontFor(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return trimmed;

  const sentences = trimmed.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  const first = sentences[0]?.trim();

  // Only the FIRST sentence, and only if it is itself a question. A question buried in the
  // middle reads as a non-sequitur without the setup that preceded it.
  if (first !== undefined && first.endsWith("?") && first.length < trimmed.length) return first;

  return trimmed;
}
