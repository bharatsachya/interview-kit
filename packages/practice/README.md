# @trao/practice

What the deck deals next, and how much of it has been faced.

Imports `@trao/contracts` and nothing else. Pure arithmetic over an append-only rating log.

## Why no model

For the same reason the schedule has none: this is a sort, and a sort that can be asserted is
worth more than one that can be argued with.

## The model of a rating

Three states rather than a score — `known`, `shaky`, `unseen`. A self-rating is not precise
enough to deserve a number, and "unseen" has to be distinguishable from "wrong": a track you have
not opened is not a weak track, and averaging the two together is how a report starts lying.

Ratings **accumulate** rather than being per-session. A session is one sitting and a reload
starts a new one, but the history behind the ordering is the whole log.

## The order, and the one refinement worth defending

The brief asks for the next session to be ordered by lowest confidence. `priorityOf` is that,
with one change: **an explicit "shaky" outranks a card that has never been dealt.**

    shaky (2)  →  never dealt (1)  →  unseen (0)  …  wait, lower goes first:

    unseen 0  <  never-dealt 1  <  shaky 2  <  known 3

Both a never-dealt card and a shaky one are things you cannot do yet, but one of them is a person
telling you so — and a card you have never seen is *unmeasured*, not known-weak. Putting the
unmeasured ones ahead of the cards the user just failed would answer a request to see something
again with something else.

Ties break by least-recently-rated, so a tier is worked through rather than re-drawn from the
front. A never-dealt card carries `ratedAt: 0` and therefore leads its own tier, which is what
makes a fresh deck come out in its stored order rather than shuffled.

Deterministic: the same log always produces the same deck, which is what lets this be asserted
rather than eyeballed.

## What it exports

* `nextSessionOrder` — the deck for one sitting.
* `priorityOf` / `standings` — where each card currently sits.
* `summarise` — the numbers behind the weak-spots report: which category you are shakiest in,
  driven by real practice data rather than by a guess.

## Tests

`test/order.test.ts` — the tiering above, tie-breaking, and that a rating log with repeats
resolves to the latest rating per card.
