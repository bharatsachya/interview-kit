/**
 * Practice.
 *
 * A separate store from the kit, because practice history grows without bound and the kit does
 * not. Embedding it would make every builder read — which is every keystroke's round trip —
 * carry a month of card ratings it has no use for, and would put two things with completely
 * different write rates behind one optimistic-concurrency version.
 *
 * Two implementations, like the other stores: in-memory for tests and for batch mode, MongoDB
 * for the app.
 */

/**
 * How well a card went, on the three-way scale the deck offers.
 *
 * `unseen` is the "Again" button — the user looked at the card and asked for it back. It is
 * deliberately *not* the same thing as a card with no rating at all, which is a card the deck
 * has never dealt. The difference is the presence of a rating, not its value, which is why
 * there is no fourth member here: "never drawn" is not something a person can report.
 */
export type PracticeConfidence = "unseen" | "shaky" | "known";

export interface PracticeRating {
  flashcardId: string;
  confidence: PracticeConfidence;
  ratedAt: number;
}

/**
 * One sitting with the deck.
 *
 * Ratings are appended in the order they happened and nothing is ever overwritten — rating the
 * same card twice in one session records both. A session is a log, not a scoreboard: "I got
 * this wrong and then got it right" is the useful shape, and collapsing it on write would throw
 * away the only evidence that anything improved.
 */
export interface PracticeSession {
  id: string;
  kitId: string;
  /** Null in batch mode, which has no user. Ownership is attached by the API layer only. */
  userId: string | null;
  startedAt: number;
  updatedAt: number;
  ratings: PracticeRating[];
}

export interface PracticeStore {
  /**
   * Append a rating, opening the session if this is its first.
   *
   * Upsert rather than create-then-append, because the deck's first rating and the session's
   * first existence are the same event. A client that had to open a session before it could
   * rate anything would open one every time somebody clicked Practice and looked at a card
   * without answering it.
   */
  record(session: Pick<PracticeSession, "id" | "kitId" | "userId">, rating: PracticeRating): Promise<void>;

  /** A kit's sessions, newest first. `limit` bounds a history that only ever grows. */
  listByKit(kitId: string, userId: string | null, limit?: number): Promise<PracticeSession[]>;
}
