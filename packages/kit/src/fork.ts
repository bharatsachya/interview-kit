import type { InternalKit, KitLineage } from "./types";

/**
 * A rewrite, as a new document rather than as a write to the old one.
 *
 * The builder's small edits — rename a day, pin a question, fix a typo — mutate in place and
 * bump `version`, because they are corrections to one thing you are working on. A rewrite is
 * not that. It throws several model calls at a section and hands back work that is genuinely
 * different, and the honest answer to "was the old one better?" is to still have the old one.
 * So the kit you pressed the button on is left byte-identical and this writes a sibling.
 *
 * Three properties, and each is a bug that has to be impossible rather than remembered:
 *
 * 1. **The parent is not touched.** Nothing here writes to `kit`; the caller saves the returned
 *    document under a new id and the old record is never opened for writing.
 * 2. **`version` restarts at 1.** A version is a per-document counter that `If-Match` compares
 *    against, and a fork is a different document. Carrying the parent's number across would
 *    mean two documents claiming version 8, and a builder holding one of them would happily
 *    write to the other.
 * 3. **Ids inside the kit are untouched.** Questions, flashcards and requirements keep the ids
 *    they had, so the schedule's `questionIds`, the practice history's `flashcardId`s and every
 *    `requirementIds` array still point at the same material. Renumbering would be a second,
 *    much worse way of saying "this is a new kit".
 *
 * The practice history is deliberately NOT carried over — it lives in its own store keyed by
 * kit id, and the confidence you built up against the parent's cards stays with the parent.
 * Copying it would claim you had practised cards that were written a moment ago.
 */
export function forkKit(
  kit: InternalKit,
  options: {
    /** The id already promised to the client when the job was accepted. */
    id: string;
    at: number;
    from: KitLineage;
  },
): InternalKit {
  return {
    ...kit,
    id: options.id,
    createdAt: options.at,
    version: 1,
    revision: (kit.revision ?? 1) + 1,
    forkedFrom: options.from,
  };
}

/**
 * What a fork is called, in one line: "Rewrote the technical questions".
 *
 * Past tense and narrow on purpose. This labels a row in the history rail, and a row that said
 * "Regenerated" would overstate what happened to a kit whose other five outputs are identical
 * to the row above it.
 */
export function lineageLabel(lineage: KitLineage): string {
  if (lineage.section === "company_brief") return "Rewrote the brief";
  if (lineage.section === "schedule") return "Rebuilt the schedule";
  return lineage.category === undefined
    ? "Rewrote the questions"
    : `Rewrote the ${lineage.category} questions`;
}
