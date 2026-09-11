"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { Confidence, ConfidenceMap } from "@/components/workspace/kit-outputs-body";

/**
 * A sitting with the deck.
 *
 * Ratings used to live in a `useState` in the drawer, which meant a reload lost every one of
 * them. That is not a missing feature so much as a broken promise: the screen says "your rating
 * feeds the weak-spots report", and a report rebuilt from nothing every time the tab is
 * refreshed is a report about the last five minutes.
 *
 * So the server holds them, in its own collection, and this is the hook that talks to it.
 *
 * ## Optimistic, and deliberately not awaited
 *
 * `rate` updates local state and posts in the background. A person rating a card is already
 * looking at the next one before the round trip finishes, and making the deck wait would make
 * the fastest interaction in the app the slowest. A post that fails costs one card's worth of
 * history and says so once, rather than blocking the session.
 *
 * ## The deck order comes from the server
 *
 * Ordering by lowest confidence is arithmetic over the whole rating history, and the history is
 * on the server. Computing it here would mean shipping every session to the browser to sort a
 * list of ids. The order is fetched once per sitting and held for its duration — a deck that
 * re-sorted itself under the user as they rated would move the card they were about to see.
 */
export interface PracticeState {
  /** Rated cards only. A card that is absent has never been dealt, which is a different fact. */
  confidence: ConfidenceMap;
  /** Flashcard ids, lowest confidence first. Empty until the first load lands. */
  deck: readonly string[];
  loading: boolean;
  /** Set when a rating could not be saved. The deck keeps working; the history has a hole. */
  error: string | null;
  rate: (flashcardId: string, value: Confidence) => void;
}

export function usePractice(kitId: string | null): PracticeState {
  const [loaded, setLoaded] = useState<{ kitId: string; sessionId: string; deck: string[]; confidence: ConfidenceMap } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kitId === null) return;
    const controller = new AbortController();

    api
      .openPractice(kitId, controller.signal)
      .then((view) => {
        if (controller.signal.aborted) return;
        const confidence: Record<string, Confidence> = {};
        for (const standing of view.standings) {
          if (standing.confidence !== null) confidence[standing.flashcard_id] = standing.confidence;
        }
        setLoaded({ kitId, sessionId: view.session_id, deck: view.deck, confidence });
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        // The deck still works without this — it falls back to stored order and an empty
        // history — so this is a notice, not an empty state.
        setError(cause instanceof Error ? cause.message : "Could not load your practice history.");
      });

    return () => controller.abort();
  }, [kitId]);

  const current = loaded?.kitId === kitId ? loaded : null;

  const rate = useCallback(
    (flashcardId: string, value: Confidence) => {
      if (kitId === null || current === null) return;

      setLoaded((previous) =>
        previous === null || previous.kitId !== kitId
          ? previous
          : { ...previous, confidence: { ...previous.confidence, [flashcardId]: value } },
      );

      void api
        .recordPractice(kitId, { session_id: current.sessionId, flashcard_id: flashcardId, confidence: value })
        .then(() => setError(null))
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? `Rating not saved: ${cause.message}` : "Rating not saved.");
        });
    },
    [kitId, current],
  );

  return {
    confidence: current?.confidence ?? {},
    deck: current?.deck ?? [],
    loading: kitId !== null && current === null && error === null,
    error,
    rate,
  };
}
