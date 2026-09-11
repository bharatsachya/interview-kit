import { describe, expect, it } from "vitest";
import type { PracticeConfidence, PracticeSession } from "@trao/contracts";
import { nextSessionOrder, standings, summarise } from "../src/index";

/**
 * The deck's order is arithmetic, like the schedule. That is the whole reason it is testable:
 * the same log always produces the same deck, so "order the next session by lowest confidence"
 * is a property rather than an impression.
 */

const CARDS = ["f1", "f2", "f3", "f4"];

function session(id: string, ratings: [string, PracticeConfidence, number][]): PracticeSession {
  return {
    id,
    kitId: "kit_1",
    userId: "user-a",
    startedAt: ratings[0]?.[2] ?? 0,
    updatedAt: ratings[ratings.length - 1]?.[2] ?? 0,
    ratings: ratings.map(([flashcardId, confidence, ratedAt]) => ({ flashcardId, confidence, ratedAt })),
  };
}

describe("nextSessionOrder", () => {
  it("keeps stored order when nothing has been practised", () => {
    expect(nextSessionOrder(CARDS, [])).toEqual(CARDS);
  });

  it("puts the lowest confidence first", () => {
    const log = [
      session("s1", [
        ["f1", "known", 100],
        ["f2", "shaky", 200],
        ["f3", "unseen", 300],
        ["f4", "known", 400],
      ]),
    ];

    expect(nextSessionOrder(CARDS, log)).toEqual(["f3", "f2", "f1", "f4"]);
  });

  it("deals an explicit Again before a card it has never dealt", () => {
    // Both are things you cannot do yet. One of them is a person saying so.
    const log = [session("s1", [["f4", "unseen", 100]])];

    expect(nextSessionOrder(CARDS, log)[0]).toBe("f4");
    expect(nextSessionOrder(CARDS, log).slice(1)).toEqual(["f1", "f2", "f3"]);
  });

  it("puts a never-dealt card ahead of one rated shaky", () => {
    const log = [session("s1", [["f1", "shaky", 100]])];

    expect(nextSessionOrder(CARDS, log)).toEqual(["f2", "f3", "f4", "f1"]);
  });

  it("takes the latest rating for a card, not the first", () => {
    const log = [
      session("s2", [["f1", "known", 900]]),
      session("s1", [["f1", "unseen", 100]]),
    ];

    // Newest session first in the list, oldest ratings first within one — so neither iteration
    // order alone is the answer, and the timestamp has to be what decides.
    expect(standings(CARDS, log)[0]).toMatchObject({ flashcardId: "f1", confidence: "known", attempts: 2 });
    expect(nextSessionOrder(CARDS, log)).toEqual(["f2", "f3", "f4", "f1"]);
  });

  it("breaks a tie by least recently rated, so a tier is worked through rather than redrawn", () => {
    const log = [
      session("s1", [
        ["f1", "shaky", 900],
        ["f2", "shaky", 100],
        ["f3", "shaky", 500],
      ]),
    ];

    expect(nextSessionOrder(["f1", "f2", "f3"], log)).toEqual(["f2", "f3", "f1"]);
  });

  it("drops ratings for a card the user has since deleted", () => {
    const log = [session("s1", [["gone", "unseen", 100]])];

    expect(nextSessionOrder(CARDS, log)).toEqual(CARDS);
    expect(standings(CARDS, log).map((s) => s.flashcardId)).toEqual(CARDS);
  });

  it("is a total order — the result does not depend on sort stability", () => {
    const log = [
      session("s1", [
        ["f1", "known", 100],
        ["f2", "known", 100],
      ]),
    ];

    expect(nextSessionOrder(["f1", "f2"], log)).toEqual(["f1", "f2"]);
    expect(nextSessionOrder(["f2", "f1"], log)).toEqual(["f2", "f1"]);
  });
});

describe("summarise", () => {
  it("counts a card you faced and missed as covered", () => {
    // Covered means faced, not answered well. Counting a miss as uncovered would mean the only
    // way to make progress visible is to be right.
    const log = [
      session("s1", [
        ["f1", "known", 100],
        ["f2", "shaky", 200],
        ["f3", "unseen", 300],
      ]),
    ];

    expect(summarise(CARDS, log)).toEqual({
      total: 4,
      covered: 3,
      notCovered: 1,
      known: 1,
      shaky: 1,
      again: 1,
      lastPractisedAt: 300,
    });
  });

  it("reports an untouched deck as nothing covered and never practised", () => {
    expect(summarise(CARDS, [])).toMatchObject({ total: 4, covered: 0, notCovered: 4, lastPractisedAt: null });
  });
});
