import type { PracticeConfidence, PracticeRating, PracticeSession } from "@trao/contracts";

/**
 * What the deck knows about one card.
 *
 * `confidence` is the most recent rating, or null for a card the deck has never dealt. The two
 * are different facts and the null is what carries the difference — see `PracticeConfidence`.
 */
export interface CardStanding {
  flashcardId: string;
  confidence: PracticeConfidence | null;
  /** When it was last rated, or 0 for never. */
  ratedAt: number;
  /** How many times it has been rated, across every session. */
  attempts: number;
}

/**
 * The latest standing of every card, folded out of the session log.
 *
 * Sessions are append-only and a card can appear in several of them, so "how am I doing on this
 * card" is a fold rather than a lookup. Done here rather than in the store because it is a
 * question about practice, not about storage — and because the store's job is to hand back what
 * was written, not to interpret it.
 *
 * Cards not in `flashcardIds` are dropped: a rating for a card the user has since deleted is
 * history, and history should not put a card back in the deck.
 */
export function standings(
  flashcardIds: readonly string[],
  sessions: readonly PracticeSession[],
): CardStanding[] {
  const live = new Set(flashcardIds);
  const byCard = new Map<string, CardStanding>(
    flashcardIds.map((id) => [id, { flashcardId: id, confidence: null, ratedAt: 0, attempts: 0 }]),
  );

  for (const rating of everyRating(sessions)) {
    if (!live.has(rating.flashcardId)) continue;
    const standing = byCard.get(rating.flashcardId) as CardStanding;
    standing.attempts += 1;
    // Latest wins, and "latest" is by timestamp rather than by iteration order: sessions arrive
    // newest-first and a session's own ratings are oldest-first, so neither order alone is the
    // answer.
    if (rating.ratedAt >= standing.ratedAt) {
      standing.confidence = rating.confidence;
      standing.ratedAt = rating.ratedAt;
    }
  }

  return flashcardIds.flatMap((id) => {
    const standing = byCard.get(id);
    return standing === undefined ? [] : [standing];
  });
}

/**
 * Where a card sits in the queue. Lower goes first.
 *
 * The brief asks for the next session to be ordered by lowest confidence. This is that, with
 * one refinement worth defending: an **explicit "Again" outranks a card that has never been
 * dealt**. Both are things you cannot do yet, but one of them is a person telling you so. A
 * card you have never seen is unmeasured, not known-weak, and putting the unmeasured ones ahead
 * of the cards the user just failed would answer a request to see something again with
 * something else.
 *
 * After those two, it is plain lowest-confidence: shaky before known.
 */
const RANK: Record<PracticeConfidence, number> = {
  unseen: 0,
  shaky: 2,
  known: 3,
};

/** A card with no rating at all — between "I just failed this" and "I was shaky on this". */
const NEVER_DEALT = 1;

export function priorityOf(standing: CardStanding): number {
  return standing.confidence === null ? NEVER_DEALT : RANK[standing.confidence];
}

/**
 * The order the next session deals its cards in.
 *
 * Ties break by least-recently-rated, so a tier is worked through rather than re-drawn from the
 * front — a never-dealt card carries `ratedAt: 0` and therefore leads its own tier, which is
 * what makes a fresh deck come out in its stored order rather than shuffled.
 *
 * Deterministic, and no model is involved. The same input always produces the same deck, which
 * is what lets this be asserted rather than eyeballed.
 */
export function nextSessionOrder(
  flashcardIds: readonly string[],
  sessions: readonly PracticeSession[],
): string[] {
  const position = new Map(flashcardIds.map((id, index) => [id, index]));

  return standings(flashcardIds, sessions)
    .sort((a, b) => {
      const byPriority = priorityOf(a) - priorityOf(b);
      if (byPriority !== 0) return byPriority;
      if (a.ratedAt !== b.ratedAt) return a.ratedAt - b.ratedAt;
      // Stored order last, so the result is total rather than dependent on sort stability.
      return (position.get(a.flashcardId) ?? 0) - (position.get(b.flashcardId) ?? 0);
    })
    .map((standing) => standing.flashcardId);
}

/**
 * Covered and not covered, which the brief asks the practice screen to show.
 *
 * "Covered" is *rated at least once*, not "rated well". A card you failed is a card you have
 * faced, and counting it as uncovered would mean the only way to make progress visible is to be
 * right — which is the opposite of what the number is for.
 */
export interface PracticeSummary {
  total: number;
  covered: number;
  notCovered: number;
  known: number;
  shaky: number;
  /** Rated "Again" — faced and missed. Distinct from `notCovered`, which was never dealt. */
  again: number;
  /** Epoch millis of the most recent rating across every session, or null if there are none. */
  lastPractisedAt: number | null;
}

export function summarise(
  flashcardIds: readonly string[],
  sessions: readonly PracticeSession[],
): PracticeSummary {
  const all = standings(flashcardIds, sessions);
  const rated = all.filter((s) => s.confidence !== null);

  return {
    total: all.length,
    covered: rated.length,
    notCovered: all.length - rated.length,
    known: rated.filter((s) => s.confidence === "known").length,
    shaky: rated.filter((s) => s.confidence === "shaky").length,
    again: rated.filter((s) => s.confidence === "unseen").length,
    lastPractisedAt: rated.reduce<number | null>(
      (latest, s) => (latest === null || s.ratedAt > latest ? s.ratedAt : latest),
      null,
    ),
  };
}

function* everyRating(sessions: readonly PracticeSession[]): Generator<PracticeRating> {
  for (const session of sessions) {
    for (const rating of session.ratings) yield rating;
  }
}
