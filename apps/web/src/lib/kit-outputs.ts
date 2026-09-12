import type { Span } from "@trao/contracts";
import { QUESTION_CATEGORIES, type InternalKit } from "@trao/kit";

/**
 * The six outputs a kit has, named once.
 *
 * The card grid in the conversation and the index rail in the panel are two views of this list,
 * so it lives here rather than in either of them. When they disagree about how many outputs
 * there are, or what one is called, the bug is that there were two lists.
 *
 * The kicker is the category word above the title. It is not decoration: six cards with only a
 * title on them read as six of the same thing, and the kicker is what says which of them is
 * research, which is a plan, and which is something you do rather than read.
 */
export const KIT_OUTPUTS = [
  { id: "brief", label: "Brief", kicker: "Research" },
  { id: "role", label: "Role", kicker: "Scorecard" },
  { id: "questions", label: "Questions", kicker: "Bank" },
  { id: "flashcards", label: "Flashcards", kicker: "Recall" },
  { id: "schedule", label: "Schedule", kicker: "Plan" },
  { id: "practice", label: "Practice", kicker: "Drill" },
] as const;

export type KitOutputId = (typeof KIT_OUTPUTS)[number]["id"];

/** Which trace steps built which output, so a card can report its own time honestly. */
const STEPS_FOR: Readonly<Record<KitOutputId, readonly string[]>> = {
  brief: ["fetch_homepage", "crawl_site", "search_discussion", "generate_brief"],
  role: ["extract_requirements"],
  questions: ["generate_questions", "coverage_check", "gap_fill"],
  flashcards: ["derive_flashcards"],
  schedule: ["allocate_schedule"],
  // Practice is not built by the pipeline — it replays what the bank already holds. A card that
  // claimed a build time here would be inventing one.
  practice: [],
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The count line under an output's title.
 *
 * Everything here is counted off the kit itself. Nothing is estimated, and an output with
 * nothing in it says zero rather than being hidden — a missing card would read as a bug, and a
 * kit that legitimately produced no flashcards is a thin kit, not a broken one.
 */
export function outputCount(id: KitOutputId, kit: InternalKit): string {
  switch (id) {
    case "brief": {
      const sections = [kit.companyBrief.whatTheyDo, kit.companyBrief.hiringProcess].filter(
        (section) => section !== "",
      ).length;
      const sources = kit.companyBrief.sources.length;
      return sources === 0
        ? "from the posting alone"
        : `${plural(sections, "section")} · ${plural(sources, "source")}`;
    }
    case "role": {
      const musts = kit.requirements.filter((requirement) => requirement.priority === "must").length;
      return `${plural(kit.requirements.length, "requirement")} · ${musts} must-have`;
    }
    case "questions": {
      const tracks = QUESTION_CATEGORIES.filter((category) =>
        kit.questions.some((question) => question.category === category),
      ).length;
      return `${plural(kit.questions.length, "question")} · ${plural(tracks, "track")}`;
    }
    case "flashcards":
      return plural(kit.flashcards.length, "card");
    case "schedule": {
      const minutes = kit.schedule.days.reduce((total, day) => total + day.minutes, 0);
      return `${plural(kit.schedule.days.length, "day")} · ${minutes} min`;
    }
    case "practice": {
      const sets = QUESTION_CATEGORIES.filter((category) =>
        kit.questions.some((question) => question.category === category),
      ).length;
      return plural(sets, "set");
    }
  }
}

/** Seconds to one decimal, the way the run line and the trace both write a duration. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * How long this output took, or null when we cannot say.
 *
 * Null is the normal case for a kit opened from history: the spans belong to the run, and the
 * run is over. A card that guessed a number rather than dropping the clause would be claiming
 * the trace said something it did not.
 */
export function outputDuration(id: KitOutputId, spans: readonly Span[]): string | null {
  const steps = STEPS_FOR[id];
  if (steps.length === 0) return null;

  // Leaves only. `generate_questions` is one step to the pipeline and four calls underneath it,
  // and adding both levels would count those four calls twice. Same rule `toStreamRows` uses to
  // decide which spans are worth drawing, for the same reason.
  const parentIds = new Set(
    spans.map((span) => span.parentId).filter((parentId): parentId is string => parentId !== null),
  );
  const total = spans
    .filter((span) => !parentIds.has(span.id))
    .filter((span) => steps.includes(span.step.split(".")[0] ?? span.step))
    .reduce((sum, span) => sum + span.durationMs, 0);

  return total === 0 ? null : seconds(total);
}

/**
 * One output, as plain text you can paste somewhere.
 *
 * What the panel's Copy button puts on the clipboard. Per-output rather than whole-kit, because
 * Copy sits in the header of the output you are reading and "copy" there can only reasonably
 * mean this one — Export is the control that takes the whole document, and it takes it as
 * Appendix A JSON.
 *
 * Written by hand per output rather than serialised generically. A kit pasted into a notes app
 * is being *read*, so it wants headings and blank lines, not JSON with the quotes stripped; and
 * provenance (`origin`, `pinned`, `active`) has no business on a clipboard any more than it has
 * in Appendix A.
 *
 * Archived items are excluded everywhere here, for the same reason the builder never renders
 * one: `active: false` means gone from every projection, and a clipboard is a projection.
 */
export function outputText(id: KitOutputId, kit: InternalKit): string {
  const title = `${kit.role.company} — ${kit.role.title}`;

  if (id === "brief") {
    const brief = kit.companyBrief;
    return join([
      title,
      "",
      brief.summary,
      section("What they do", brief.whatTheyDo),
      section("Hiring process", brief.hiringProcess),
      // The gaps travel with it. A brief pasted into a document without them reads as complete,
      // and what this kit is careful about is exactly the difference between those two.
      list("Not found", brief.gaps),
      list("Sources", brief.sources),
    ]);
  }

  if (id === "role") {
    return join([
      title,
      kit.role.location,
      "",
      kit.role.summary,
      list("Responsibilities", kit.role.responsibilities),
      list(
        "Requirements",
        kit.requirements.map((r) => `[${r.priority}] ${r.text}`),
      ),
    ]);
  }

  if (id === "questions") {
    const active = kit.questions.filter((q) => q.active);
    return join([
      `${title} — questions`,
      ...QUESTION_CATEGORIES.map((category) => {
        const mine = active.filter((q) => q.category === category);
        if (mine.length === 0) return "";
        return join([
          "",
          category.toUpperCase(),
          ...mine.map((q, index) => `\n${index + 1}. ${q.prompt}\n   ${q.answerOutline}`),
        ]);
      }),
    ]);
  }

  if (id === "flashcards" || id === "practice") {
    // Practice has no document of its own — it is the deck, drilled. So Copy there hands over
    // the deck rather than the screen, which is the only thing on it worth pasting anywhere.
    const cards = kit.flashcards.filter((f) => f.active);
    return join([
      `${title} — flashcards`,
      "",
      ...cards.map((card) => `${card.front}\n  → ${card.back}\n`),
    ]);
  }

  const byId = new Map(kit.questions.map((q) => [q.id, q]));
  return join([
    `${title} — ${kit.schedule.daysAvailable}-day plan`,
    "",
    ...kit.schedule.days.map((day) =>
      join([
        `Day ${day.day} — ${day.focus} (${day.minutes} min)`,
        ...day.questionIds.map((qid) => `  · ${byId.get(qid)?.prompt ?? qid}`),
        "",
      ]),
    ),
  ]);
}

function section(heading: string, body: string): string {
  return body.trim() === "" ? "" : `\n${heading.toUpperCase()}\n${body.trim()}`;
}

function list(heading: string, items: readonly string[]): string {
  return items.length === 0 ? "" : `\n${heading.toUpperCase()}\n${items.map((i) => `  · ${i}`).join("\n")}`;
}

/** Drops the empties, so an absent section leaves no gap where a heading would have been. */
function join(parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join("\n").trim();
}
