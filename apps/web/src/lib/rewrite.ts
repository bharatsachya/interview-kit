import type { QuestionCategory } from "@trao/kit";

/**
 * A rewrite the user has asked for but not yet sent.
 *
 * Pressing Regenerate inside the kit panel does not call anything. It stages this, the composer
 * picks it up, and the user sends it — or changes it first, or throws it away. Three reasons the
 * button stopped being the whole interaction:
 *
 * 1. **A rewrite is several model calls and a new kit.** That is the same weight as a first run,
 *    and a first run is not one click on the edge of a panel with no chance to say anything.
 * 2. **There was nowhere to say what you wanted.** "These are all too junior" is the most useful
 *    sentence a person can contribute at that moment, and a button cannot carry it. The composer
 *    can, and `instructions` reaches the prompt.
 * 3. **It happened off-screen.** The panel is a side pane; the run, the trace and the result
 *    belong in the conversation with everything else that was generated.
 *
 * `key` is new on every press so that pressing the same button twice re-arms the composer rather
 * than looking like nothing happened.
 */
export interface Rewrite {
  key: string;
  /** The kit being rewritten FROM. It is read and never written — the run forks. */
  kitId: string;
  /** "Vaultline — Senior Backend Engineer", for the chip above the prompt. */
  kitLabel: string;
  section: "company_brief" | "questions" | "schedule";
  category?: QuestionCategory;
  /** `questions:technical`, or just the section. What the turn and the run are labelled with. */
  id: string;
  /** The sentence the composer starts with. Editable, and sent as typed. */
  prompt: string;
}

/** What pressing Regenerate on this section puts in the composer. */
export function rewritePrompt(section: Rewrite["section"], category?: QuestionCategory): string {
  if (section === "company_brief") return "Rewrite the company brief.";
  if (section === "schedule") return "Rebuild the study schedule.";
  return category === undefined
    ? "Rewrite the questions."
    : `Rewrite the ${category} questions.`;
}

/**
 * What this rewrite keeps, said before it is sent rather than after.
 *
 * The old button carried this in a `title` attribute, which is a tooltip nobody reads on a phone
 * and nobody hovers on a desktop. It is the single most important fact about pressing the thing.
 */
export function rewriteKeeps(section: Rewrite["section"]): string {
  if (section === "company_brief") {
    return "The brief is rewritten from the pages already retrieved — nothing is fetched again. Everything else in the kit is copied across untouched.";
  }
  if (section === "schedule") {
    return "Days you have edited are kept exactly as they are; the rest are reallocated. Allocation is arithmetic in code, so an instruction here changes nothing — it is recorded and not acted on.";
  }
  return "Questions you have pinned, edited or written yourself are carried over. Only the ones the model wrote and you have not touched are replaced.";
}

/**
 * What a rewrite says it is doing while it runs.
 *
 * Present continuous, and narrow. The stream's default line is "Building your kit", which is a
 * plain untruth on a rewrite — the kit was built some time ago and what is running now replaces
 * one section of a copy of it.
 */
export function rewritingLabel(section: string): string {
  if (section === "company_brief") return "Rewriting the brief";
  if (section === "schedule") return "Rebuilding the schedule";
  const [, category] = section.split(":");
  return category === undefined ? "Rewriting the questions" : `Rewriting the ${category} questions`;
}

/** A stable id for one press, without needing a clock the server also has to agree with. */
let counter = 0;
export function nextRewriteKey(): string {
  counter += 1;
  return `rw${counter}`;
}
