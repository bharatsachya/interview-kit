/**
 * @trao/practice — what the deck deals next, and how much of it has been faced.
 *
 * Pure arithmetic over an append-only rating log. No model decides the order, for the same
 * reason none decides the schedule: it is a sort, and a sort that can be asserted is worth more
 * than one that can be argued with. Imports `contracts` and nothing else.
 */

export {
  nextSessionOrder,
  priorityOf,
  standings,
  summarise,
  type CardStanding,
  type PracticeSummary,
} from "./order";
