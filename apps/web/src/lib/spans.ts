import type { Span } from "@trao/contracts";

/**
 * Turning trace spans into the lines the conversation shows.
 *
 * The pipeline decides what happened; this file only decides how it reads. Every result string
 * is derived from attributes the span actually carries, so the stream cannot claim a number the
 * pipeline did not record — and a step whose attributes are missing simply shows no result
 * rather than a fabricated one.
 */

const STEP_LABELS: Readonly<Record<string, string>> = {
  extract_requirements: "Extracting requirements",
  fetch_homepage: "Fetching company site",
  crawl_site: "Crawling for hiring page",
  search_discussion: "Searching public discussion",
  generate_brief: "Writing company brief",
  generate_questions: "Generating questions",
  coverage_check: "Checking coverage",
  gap_fill: "Filling gaps",
  derive_flashcards: "Deriving flashcards",
  allocate_schedule: "Building schedule",
};

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  technical: "technical",
  behavioural: "behavioural",
  "system-design": "system-design",
  "company-fit": "company-fit",
};

/** `generate_questions.technical` → `generate_questions`. */
function baseStep(step: string): string {
  const dot = step.indexOf(".");
  return dot === -1 ? step : step.slice(0, dot);
}

/**
 * Takes the step name rather than a whole span, because the in-flight row has a step name and
 * nothing else — the step announces itself before there is a span to describe it.
 */
export function stepLabel(step: string, attrs: Record<string, unknown> = {}): string {
  const base = baseStep(step);
  if (base === "generate_questions") {
    const category = typeof attrs.category === "string" ? CATEGORY_LABELS[attrs.category] : undefined;
    if (category) return `Generating ${category} questions`;
  }
  return STEP_LABELS[base] ?? step.replace(/[_.]/g, " ");
}

/**
 * Three tones, and the middle one is the point.
 *
 * A skipped step is informational: "no search key" is a normal outcome of running without one,
 * not a failure, and drawing it as one would misreport a kit that is fine. Only a step that
 * actually errored is trouble, and even then the run continues.
 */
export type SpanTone = "done" | "info" | "trouble";

export function spanTone(span: Span): SpanTone {
  if (span.status === "failed") return "trouble";
  if (span.status === "skipped") return "info";
  return "done";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The text after the arrow. Null when the step has nothing worth reporting. */
export function spanResult(span: Span): string | null {
  const attrs = span.attrs;

  if (span.status === "skipped") {
    const reason = str(attrs.reason);
    return reason ? `skipped, ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : "skipped";
  }
  if (span.status === "failed") return span.error?.message ?? "failed";

  switch (baseStep(span.step)) {
    case "extract_requirements": {
      const found = num(attrs.requirements);
      const must = num(attrs.must_have);
      if (found === null) return null;
      return must === null ? `${found} found` : `${found} found, ${must} must-have`;
    }
    case "fetch_homepage":
      return str(attrs.host);
    case "crawl_site": {
      const hiring = str(attrs.hiring_page);
      if (hiring) return `found ${hiring}`;
      const pages = num(attrs.pages_fetched);
      return pages === null ? null : `${pages} pages, no hiring page`;
    }
    case "generate_questions": {
      const count = num(attrs.count);
      return count === null ? null : String(count);
    }
    case "coverage_check": {
      const pass = num(attrs.pass);
      const gaps = num(attrs.gaps);
      if (pass === null) return null;
      if (gaps === null) return `pass ${pass}`;
      return gaps === 0 ? `pass ${pass}: all must-haves covered` : `pass ${pass}: ${gaps} ${gaps === 1 ? "gap" : "gaps"}`;
    }
    case "gap_fill": {
      const covered = Array.isArray(attrs.covered) ? attrs.covered.filter((id): id is string => typeof id === "string") : [];
      if (covered.length === 0) return null;
      return `${covered.join(", ")} covered`;
    }
    case "derive_flashcards": {
      const count = num(attrs.count);
      return count === null ? null : `${count} cards`;
    }
    case "allocate_schedule": {
      const days = num(attrs.days);
      const minutes = num(attrs.minutes);
      if (days === null) return null;
      const dayText = `${days} ${days === 1 ? "day" : "days"}`;
      return minutes === null ? dayText : `${dayText}, ${minutes} minutes`;
    }
    default:
      return str(attrs.degraded);
  }
}

/**
 * What a failure means for the kit, in the kit's terms rather than the pipeline's.
 *
 * A step failing is not the run failing, so the line says what the person still gets.
 */
export function spanConsequence(span: Span): string | null {
  if (span.status !== "failed") {
    return typeof span.attrs.degraded === "string" ? span.attrs.degraded : null;
  }
  return baseStep(span.step) === "fetch_homepage" || baseStep(span.step) === "crawl_site"
    ? "generating from the job description alone"
    : "the rest of the kit is unaffected";
}

/**
 * The rows to draw, in the order they happened.
 *
 * A span with children is dropped in favour of them: `generate_questions` is one step to the
 * pipeline but four calls to a reader, and the four say more than the one. Anything without
 * children is its own row, which is why two coverage passes read as two lines.
 */
export function toStreamRows(spans: readonly Span[]): Span[] {
  const parentIds = new Set(spans.map((span) => span.parentId).filter((id): id is string => id !== null));
  return spans.filter((span) => !parentIds.has(span.id));
}
