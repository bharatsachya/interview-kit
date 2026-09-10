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
