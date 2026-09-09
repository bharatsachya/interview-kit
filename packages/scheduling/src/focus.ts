import type { InternalQuestion, Requirement } from "@trao/kit";

/**
 * Day focus, derived in code from what the day is actually about.
 *
 * The model never writes these. A focus line is a label for whatever the arithmetic already put
 * on the day — asking a model for it would mean the label and the contents could disagree, and
 * it would cost a call per day for something the requirement texts already say.
 *
 * The first version labelled days by question category, which produced "Technical depth" three
 * times and "Mixed practice" for everything else. That is a schedule you cannot navigate: it
 * tells you the shape of the questions and nothing about the subject. A focus should say
 * "Sub-agent state and interrupts", because that is what you would write in a calendar.
 */

/** Shown when the kit produced no questions at all. Honest rather than blank. */
export const EMPTY_DAY_FOCUS = "Nothing scheduled — the job description produced no questions";

/** Naming more subjects than this stops being a label and starts being a list. */
const MAX_SUBJECTS = 3;

/** Words at the start of a requirement that describe the candidate, not the subject. */
const LEADING_FILLER =
  /^(?:\d+\+?\s*years?\s+(?:of\s+)?(?:experience\s+)?(?:building|with|in|working\s+with)?\s*|(?:deep\s+|strong\s+|proven\s+|demonstrated\s+|hands-on\s+)?experience\s+(?:with|of|in|operating|building)\s+|ability\s+to\s+|prior\s+work\s+(?:on|in)\s+|a\s+background\s+in\s+|familiarity\s+with\s+|knowledge\s+of\s+|you\s+(?:will\s+|'ll\s+)?)/i;

const MAX_LABEL_WORDS = 6;

/**
 * A requirement text reduced to the thing it is about.
 *
 * "Orchestration UX — sub-agent state, streaming partial output, exposing memory" is one
 * subject with a gloss after it; the part before the dash is the label. "5+ years building
 * production services in Python" leads with a qualification, and the subject is what follows.
 */
export function subjectOf(requirementText: string): string {
  let text = requirementText.trim().replace(/\s+/g, " ");

  // A dash, colon or semicolon introduces a gloss; the head is the subject.
  const head = text.split(/\s+[—–-]\s+|:\s+|;\s+/)[0];
  if (head !== undefined && head.trim().length >= 3) text = head.trim();

  text = text.replace(LEADING_FILLER, "").trim();
  text = text.replace(/[.,;:]+$/, "");

  // Long labels are shortened at a clause boundary or not at all. A hard word cut produces
  // "Mentoring junior engineers and reviewing their", which is worse than the full sentence:
  // a truncation that ends on "their" reads as a bug, and a label nobody trusts is not a label.
  if (text.split(" ").length > MAX_LABEL_WORDS) {
    // A comma is the strongest boundary a requirement text offers: "take an ambiguous spec,
    // scope it, and ship something usable in days" is one subject with two elaborations.
    const beforeComma = (text.split(",")[0] ?? text).trim();
    if (beforeComma.split(" ").length >= 2) text = beforeComma;
  }

  const words = text.split(" ").filter(Boolean);
  if (words.length > MAX_LABEL_WORDS) {
    const boundary = words.slice(0, MAX_LABEL_WORDS).findLastIndex((word) => /^(and|or|with|including|plus|for|that)$/i.test(word));
    if (boundary > 1) text = words.slice(0, boundary).join(" ").replace(/,$/, "");
  }

  if (text.length === 0) return requirementText.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinSubjects(subjects: readonly string[]): string {
  if (subjects.length === 1) return subjects[0] as string;
  if (subjects.length === 2) return `${subjects[0]} and ${subjects[1]}`;
  return `${subjects.slice(0, -1).join(", ")} and ${subjects.at(-1) as string}`;
}

export interface DayForFocus {
  questions: readonly InternalQuestion[];
  review: boolean;
}

/**
 * Label every day at once, because a good label depends on the other days.
 *
 * Days are named after the requirements most particular to them: a requirement that appears on
 * one day identifies that day, and one that appears on five identifies none of them. Labelling
 * each day in isolation gives every day the same first requirement and therefore the same name,
 * which is the failure the old category labels had in a different costume.
 */
export function assignFocuses(
  days: readonly DayForFocus[],
  requirements: ReadonlyMap<string, Requirement>,
  weightOf: (requirement: Requirement) => number = () => 1,
): string[] {
  const daysPerRequirement = new Map<string, number>();
  for (const day of days) {
    for (const id of requirementIdsOf(day.questions, requirements)) {
      daysPerRequirement.set(id, (daysPerRequirement.get(id) ?? 0) + 1);
    }
  }

  return days.map((day) => {
    if (day.questions.length === 0) return EMPTY_DAY_FOCUS;

    const ids = requirementIdsOf(day.questions, requirements);
    const ranked = ids
      .map((id) => requirements.get(id) as Requirement)
      .sort(
        (a, b) =>
          // Rarest across the schedule first — that is what makes this day this day.
          (daysPerRequirement.get(a.id) ?? 0) - (daysPerRequirement.get(b.id) ?? 0) ||
          weightOf(b) - weightOf(a) ||
          a.id.localeCompare(b.id),
      );

    const subjects: string[] = [];
    for (const requirement of ranked) {
      const subject = subjectOf(requirement.text);
      if (!subjects.includes(subject)) subjects.push(subject);
      if (subjects.length === MAX_SUBJECTS) break;
    }

    // No requirement survived — company-fit questions can legitimately carry none. Fall back to
    // the question's own words rather than to a generic label.
    const label = subjects.length > 0 ? joinSubjects(subjects) : subjectOf(firstPromptSubject(day.questions));

    return day.review ? `Review — ${lowerFirst(label)}` : label;
  });
}

function requirementIdsOf(
  questions: readonly InternalQuestion[],
  requirements: ReadonlyMap<string, Requirement>,
): string[] {
  const seen: string[] = [];
  for (const question of questions) {
    for (const id of question.requirementIds) {
      if (requirements.has(id) && !seen.includes(id)) seen.push(id);
    }
  }
  return seen;
}

/**
 * The subject of a question that covers no requirement.
 *
 * Questions grounded in a responsibility rather than a requirement have no id to name them by,
 * so the label comes from the prompt. A prompt is a sentence, not a phrase, and needs a firmer
 * hand than a requirement text: the interrogative stem carries no information ("Tell me about a
 * time when you…"), and what follows runs to twenty words. Cutting at a clause boundary here is
 * the whole job rather than an edge case, so the word cap is enforced.
 */
const QUESTION_STEM =
  /^(?:tell me about(?: a)?(?: time(?: when)?)?|describe(?: a| the| your)?|walk (?:me )?through(?: a| the)?|design(?: a| the)?|explain(?: how| why| the)?|how (?:would|do|did) you|what (?:would|do|did) you|given [^,]+,\s*)\s*/i;

const BOUNDARY_WORD = /^(and|or|with|for|that|where|which|when|using|across|including|plus|to|in|on|at|from|by)$/i;
const MAX_QUESTION_LABEL_WORDS = 8;

function firstPromptSubject(questions: readonly InternalQuestion[]): string {
  const prompt = (questions[0]?.prompt ?? "").trim().replace(/\s+/g, " ");
  if (prompt.length === 0) return "";

  let text = (prompt.split(/[?.]/)[0] ?? prompt).trim();
  text = text.replace(QUESTION_STEM, "").trim();
  text = (text.split(",")[0] ?? text).trim();

  const words = text.split(" ").filter(Boolean);
  if (words.length > MAX_QUESTION_LABEL_WORDS) {
    const head = words.slice(0, MAX_QUESTION_LABEL_WORDS);
    const boundary = head.findLastIndex((word) => BOUNDARY_WORD.test(word));
    text = (boundary > 1 ? head.slice(0, boundary) : head).join(" ");
  }

  return text.length > 0 ? text : prompt;
}

/** "AI or agent products" must not become "aI or agent products". */
function lowerFirst(value: string): string {
  const first = value.charAt(0);
  const second = value.charAt(1);
  if (second !== "" && second === second.toUpperCase() && second !== second.toLowerCase()) return value;
  return first.toLowerCase() + value.slice(1);
}
