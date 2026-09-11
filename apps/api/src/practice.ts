import { Router } from "express";
import { z } from "zod";
import type { Clock, IdGenerator, KitStore, PracticeStore } from "@trao/contracts";
import type { Authenticator } from "@trao/auth";
import { getKitForBuilder, type InternalKit } from "@trao/kit";
import { nextSessionOrder, standings, summarise } from "@trao/practice";
import { guarded, notFound, ownedKit } from "./http";
import { parseBody } from "./schemas";

/**
 * Practice.
 *
 * Two routes, because a sitting with the deck is two questions: *what should I be shown next*
 * and *here is how that went*. The first is answered from the whole rating history, the second
 * appends one line to it.
 *
 * ## Why this is not part of the builder
 *
 * A rating is not an edit to the kit. It carries no version, it takes no `If-Match`, and two
 * tabs rating the same card do not conflict — both ratings happened and the log keeps both.
 * Routing it through the builder's write path would give it an optimistic-concurrency check it
 * has no use for and would bump the kit's version on every card, which would make a practice
 * session look, to anyone holding the kit open in another tab, like somebody else editing it.
 *
 * Sessions live in their own collection for the plainer reason that they grow without bound and
 * the kit does not.
 */

export interface PracticeDeps {
  auth: Authenticator;
  kits: KitStore<InternalKit>;
  practice: PracticeStore;
  ids: IdGenerator;
  clock: Clock;
}

/** How much history the order is computed from. Fifty sittings is far more than a fortnight. */
const HISTORY_LIMIT = 50;

const ratingSchema = z
  .object({
    session_id: z.string().min(1).max(200),
    flashcard_id: z.string().min(1).max(200),
    confidence: z.enum(["unseen", "shaky", "known"]),
  })
  .strict();

export function practiceRoutes(deps: PracticeDeps): Router {
  const router = Router();

  /**
   * Open a sitting.
   *
   * Returns the order to deal in, what the deck already knows about each card, and a session id
   * to hang the ratings off. The id is minted here rather than by the client so a browser cannot
   * choose one that collides with a session somebody else is in the middle of.
   *
   * A fresh id on every call is deliberate: a session is one sitting, and a reload is a new one.
   */
  router.get(
    "/kits/:kitId/practice",
    guarded(deps.auth, async (req, res, userId) => {
      const record = await ownedKit(deps.kits, req.params["kitId"] ?? "", userId);
      if (record === null) return notFound(res);

      // The builder projection, so a deleted card cannot be dealt and an archived one cannot
      // come back — the same list the deck is rendered from.
      const cards = getKitForBuilder(record.kit).flashcards.map((f) => f.id);
      const sessions = await deps.practice.listByKit(record.id, userId, HISTORY_LIMIT);

      res.set("cache-control", "no-store").json({
        session_id: deps.ids.next("practice_"),
        deck: nextSessionOrder(cards, sessions),
        standings: standings(cards, sessions).map((s) => ({
          flashcard_id: s.flashcardId,
          confidence: s.confidence,
          rated_at: s.ratedAt === 0 ? null : s.ratedAt,
          attempts: s.attempts,
        })),
        summary: summaryBody(summarise(cards, sessions)),
      });
    }),
  );

  /**
   * Record one card.
   *
   * One request per rating, which is a deliberate click rather than a keystroke — the thing the
   * builder debounces does not apply here. The client updates its own state immediately and does
   * not wait for this; a rating that fails to save costs the user a card's worth of history, and
   * blocking the deck on a round trip would cost them the session.
   */
  router.post(
    "/kits/:kitId/practice",
    guarded(deps.auth, async (req, res, userId) => {
      const record = await ownedKit(deps.kits, req.params["kitId"] ?? "", userId);
      if (record === null) return notFound(res);

      const body = parseBody(ratingSchema, req.body);
      if (!body.ok) return void res.status(400).json(body.error);

      // A rating for a card that is not in the deck is not history, it is a bug in the client or
      // a card deleted in another tab. Refused rather than stored, so the log cannot accumulate
      // rows that `standings` will only ever throw away.
      const live = record.kit.flashcards.some((f) => f.id === body.value.flashcard_id && f.active);
      if (!live) return notFound(res, "flashcard");

      await deps.practice.record(
        { id: body.value.session_id, kitId: record.id, userId },
        {
          flashcardId: body.value.flashcard_id,
          confidence: body.value.confidence,
          // Server time, not the client's. A clock skewed by a day would otherwise pin a card to
          // the front or the back of the deck forever, because ordering breaks ties on it.
          ratedAt: deps.clock.now(),
        },
      );

      const cards = getKitForBuilder(record.kit).flashcards.map((f) => f.id);
      const sessions = await deps.practice.listByKit(record.id, userId, HISTORY_LIMIT);

      res.set("cache-control", "no-store").json({ summary: summaryBody(summarise(cards, sessions)) });
    }),
  );

  return router;
}

function summaryBody(summary: ReturnType<typeof summarise>): Record<string, unknown> {
  return {
    total: summary.total,
    covered: summary.covered,
    not_covered: summary.notCovered,
    known: summary.known,
    shaky: summary.shaky,
    again: summary.again,
    last_practised_at: summary.lastPractisedAt,
  };
}
