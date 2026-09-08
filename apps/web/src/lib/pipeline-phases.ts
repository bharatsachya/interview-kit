import type { Span } from "@trao/contracts";

/**
 * How the nine pipeline steps are shown to somebody watching.
 *
 * The steps are the pipeline's, not ours — the progress screen reads span names off the trace,
 * so this file only decides how they are grouped and worded. A step the pipeline stops emitting
 * disappears from the screen; a step it adds shows up under "Other work" rather than vanishing,
 * because a silent omission is the one failure mode a progress display must not have.
 *
 * Four phases rather than nine rows: nine is a list to audit, four is a thing to watch. The
 * per-step detail is still there, one level down.
 */

export const STEP_LABELS: Readonly<Record<string, string>> = {
  extract_requirements: "Reading the requirements",
  fetch_homepage: "Fetching the homepage",
  crawl_site: "Crawling for a hiring page",
  search_discussion: "Searching for public discussion",
  generate_brief: "Writing the company brief",
  generate_questions: "Writing questions",
  coverage_check: "Checking every must-have is covered",
  gap_fill: "Filling the gaps",
  derive_flashcards: "Making flashcards",
  allocate_schedule: "Allocating the days",
};

export interface Phase {
  id: string;
  label: string;
  steps: readonly string[];
}

export const PHASES: readonly Phase[] = [
  { id: "read", label: "Reading the description", steps: ["extract_requirements"] },
  {
    id: "research",
    label: "Researching the company",
    steps: ["fetch_homepage", "crawl_site", "search_discussion", "generate_brief"],
  },
  {
    id: "write",
    label: "Writing the questions",
    steps: ["generate_questions", "coverage_check", "gap_fill"],
  },
  { id: "plan", label: "Building the plan", steps: ["derive_flashcards", "allocate_schedule"] },
];

export type PhaseState = "pending" | "running" | "done" | "degraded" | "failed";

export interface PhaseView {
  phase: Phase;
  state: PhaseState;
  /** Top-level spans for this phase, in the order the pipeline ran them. */
  spans: Span[];
  elapsedMs: number;
}

/**
 * `degraded` is the state that matters most here.
 *
 * A skipped search or an unreachable site is not a failure and must not be drawn as one — the
 * run carries on and the kit records what it lacks. Only a step that actually errored is
 * `failed`, and even then the phase keeps going. Nothing on this screen turns red for an
 * outcome the product considers a success.
 */
export function toPhaseViews(spans: readonly Span[], jobDone: boolean): PhaseView[] {
  const topLevel = spans.filter((span) => span.parentId === null);

  return PHASES.map((phase) => {
    const own = topLevel.filter((span) => phase.steps.includes(span.step));
    const elapsedMs = own.reduce((total, span) => total + span.durationMs, 0);

    let state: PhaseState;
    if (own.length === 0) {
      state = "pending";
    } else if (own.some((span) => span.status === "failed")) {
      state = "failed";
    } else if (own.length < phase.steps.length && !jobDone) {
      state = "running";
    } else if (own.some((span) => span.status === "skipped" || "degraded" in span.attrs)) {
      state = "degraded";
    } else {
      state = "done";
    }

    return { phase, state, spans: own, elapsedMs };
  });
}

/** Steps the pipeline emitted that no phase claims. Shown rather than dropped. */
export function unclaimedSpans(spans: readonly Span[]): Span[] {
  const claimed = new Set(PHASES.flatMap((phase) => phase.steps));
  return spans.filter((span) => span.parentId === null && !claimed.has(span.step));
}

export function stepLabel(step: string): string {
  return STEP_LABELS[step] ?? step.replace(/_/g, " ");
}

/**
 * The plain-language reason a step did less than it might have.
 *
 * Read from the span's own attributes rather than composed here, so the screen cannot claim a
 * degradation the pipeline did not record.
 */
export function spanNote(span: Span): string | null {
  if (span.error) return span.error.message;
  if (typeof span.attrs.reason === "string") return span.attrs.reason;
  if (typeof span.attrs.degraded === "string") return span.attrs.degraded;
  return null;
}
