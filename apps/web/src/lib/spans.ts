import type { Span } from "@trao/contracts";

/**
 * Turning trace spans into the lines the conversation shows.
 *
 * The pipeline decides what happened; this file only decides how it reads. Every result string
 * is derived from attributes the span actually carries, so the stream cannot claim a number the
 * pipeline did not record — and a step whose attributes are missing shows no result rather than
 * a fabricated one.
 *
 * The vocabulary here is the pipeline's, read off a real run rather than agreed in advance.
 * Three of its step names carry a value in the name itself — `category:technical`,
 * `coverage_check pass=2`, `gap_fill REQ-09+REQ-11` — which is why parsing the name is the
 * first thing that happens.
 */

interface StepParts {
  base: string;
  category?: string;
  pass?: number;
  ids?: string[];
}

/**
 * Split a step name into its base and whatever it carries.
 *
 * Tolerant on purpose: an unrecognised shape falls through as a plain base name, so a step
 * added later renders as itself instead of disappearing.
 */
export function parseStep(step: string): StepParts {
  const category = /^category:(.+)$/.exec(step);
  if (category?.[1]) return { base: "category", category: category[1] };

  const pass = /^coverage_check pass=(\d+)$/.exec(step);
  if (pass?.[1]) return { base: "coverage_check", pass: Number(pass[1]) };

  const gap = /^gap_fill (.+)$/.exec(step);
  if (gap?.[1]) return { base: "gap_fill", ids: gap[1].split("+").filter(Boolean) };

  return { base: step };
}

const STEP_LABELS: Readonly<Record<string, string>> = {
  generate_kit: "Building the kit",
  extract_requirements: "Extracting requirements",
  fetch_homepage: "Fetching company site",
  crawl_site: "Crawling for hiring page",
  search_discussion: "Searching public discussion",
  generate_brief: "Writing company brief",
  generate_questions: "Generating questions",
  coverage: "Checking coverage",
  coverage_check: "Checking coverage",
  gap_fill: "Filling gaps",
  derive_flashcards: "Deriving flashcards",
  allocate_schedule: "Building schedule",
  serialize_kit: "Checking the kit",
};

/**
 * Takes the step name rather than a whole span, because the in-flight row has a step name and
 * nothing else — the step announces itself before there is a span to describe it.
 */
export function stepLabel(step: string, attrs: Record<string, unknown> = {}): string {
  const parts = parseStep(step);
  if (parts.base === "category") {
    const category = parts.category ?? str(attrs.category);
    if (category) return `Generating ${category} questions`;
  }
  return STEP_LABELS[parts.base] ?? parts.base.replace(/_/g, " ");
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

function strList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function count(value: unknown, singular: string, plural = `${singular}s`): string | null {
  const total = num(value);
  return total === null ? null : `${total} ${total === 1 ? singular : plural}`;
}

/**
 * Why a step chose not to run, in words rather than in the tracer's vocabulary.
 *
 * The pipeline records a machine-readable token so the trace stays greppable. Printing that
 * token at somebody mid-run — "skipped, company_unreachable" — is showing them the inside of
 * the program. Anything unmapped falls back to the token with its underscores opened out, so a
 * reason added later degrades to readable rather than to nothing.
 */
const SKIP_REASONS: Readonly<Record<string, string>> = {
  company_unreachable: "could not reach the site",
  no_homepage: "nothing to crawl",
  no_key: "no search key",
  no_company: "no company name to search for",
  provider_error: "the search provider did not answer",
  no_requirements: "no requirements to work from",
  no_context: "nothing found to write from",
  writer_returned_nothing: "the model returned nothing usable",
  failed: "the step did not complete",
};

/**
 * The tracer writes `skip_reason`. `reason` is read too because the gap-fill gate records its
 * verdict under that name, and a reason recorded either way should still reach the reader.
 */
function skipReason(attrs: Record<string, unknown>): string | null {
  const raw = str(attrs.skip_reason) ?? str(attrs.reason);
  if (raw === null) return null;
  return SKIP_REASONS[raw] ?? raw.replace(/_/g, " ");
}

/** The text after the arrow. Null when the step has nothing worth reporting. */
export function spanResult(span: Span): string | null {
  const attrs = span.attrs;

  if (span.status === "skipped") {
    const reason = skipReason(attrs);
    return reason ? `skipped, ${reason}` : "skipped";
  }
  if (span.status === "failed") return span.error?.message ?? "failed";

  const parts = parseStep(span.step);

  switch (parts.base) {
    case "extract_requirements": {
      const found = num(attrs.requirement_count);
      if (found === null) return null;
      const must = num(attrs.must_count);
      return must === null ? `${found} found` : `${found} found, ${must} must-have`;
    }

    case "fetch_homepage": {
      // The host, not the whole URL: the row is about reaching the company, and a long careers
      // path pushes everything after it off the line.
      const url = str(attrs.url);
      if (url === null) return null;
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return url;
      }
    }

    case "crawl_site":
      return count(attrs.pages_fetched, "page");

    case "search_discussion": {
      const results = num(attrs.result_count);
      if (results === null) return null;
      return results === 0 ? "nothing found" : `${results} ${results === 1 ? "result" : "results"}`;
    }

    case "generate_brief": {
      // The pipeline writes the brief without a model when it has no pages to write from. That
      // is the degradation, and it is the thing worth saying on this row.
      if (attrs.wrote_without_model === true) return "from the job description alone";
      return count(attrs.sources_used, "source");
    }

    case "category":
    case "generate_questions":
      return count(attrs.questions_out, "question");

    case "coverage_check": {
      const gaps = strList(attrs.gaps);
      const musts = num(attrs.musts);
      const prefix = parts.pass === undefined ? "" : `pass ${parts.pass}: `;
      if (gaps === null) return parts.pass === undefined ? null : `pass ${parts.pass}`;
      // "All must-haves covered" would be a strange thing to say about a posting that stated
      // none. Reporting the absence is honest; congratulating yourself on it is not.
      if (musts === 0) return `${prefix}no must-haves stated`;
      if (gaps.length === 0) return `${prefix}all must-haves covered`;
      return `${prefix}${gaps.length} ${gaps.length === 1 ? "gap" : "gaps"}`;
    }

    case "gap_fill": {
      const ids = parts.ids ?? [];
      if (attrs.accepted === false) return ids.length > 0 ? `${ids.join(", ")} not closed` : "not closed";
      return ids.length > 0 ? `${ids.join(", ")} covered` : null;
    }

    case "coverage": {
      const passes = num(attrs.passes);
      const uncovered = strList(attrs.uncovered);
      if (passes === null) return null;
      const passText = `${passes} ${passes === 1 ? "pass" : "passes"}`;
      return uncovered && uncovered.length > 0 ? `${passText}, ${uncovered.length} still uncovered` : passText;
    }

    case "derive_flashcards":
      return count(attrs.count, "card");

    case "allocate_schedule": {
      // `days` is written as "5/5" — days built over days asked for. The first number is the
      // one the reader cares about.
      const days = str(attrs.days);
      const built = days === null ? Number.NaN : Number(days.split("/")[0]);
      const minutes = num(attrs.minutes);
      if (!Number.isFinite(built)) return minutes === null ? null : `${minutes} minutes`;
      const dayText = `${built} ${built === 1 ? "day" : "days"}`;
      return minutes === null ? dayText : `${dayText}, ${minutes} minutes`;
    }

    case "serialize_kit": {
      const questions = num(attrs.questions);
      const flashcards = num(attrs.flashcards);
      if (questions === null) return null;
      return flashcards === null ? `${questions} questions` : `${questions} questions, ${flashcards} cards`;
    }

    default:
      return str(attrs.degraded);
  }
}

/**
 * What a step's outcome means for the kit, in the kit's terms rather than the pipeline's.
 *
 * A step failing is not the run failing, so the line says what the person still gets.
 */
export function spanConsequence(span: Span): string | null {
  const base = parseStep(span.step).base;
  const research = base === "fetch_homepage" || base === "crawl_site";

  if (span.status === "failed") {
    return research ? "generating from the job description alone" : "the rest of the kit is unaffected";
  }

  // A skipped research step is the same outcome as a failed one from the reader's side: there
  // is no company material, and the kit comes from the description. Saying so here is what
  // stops the row reading as an unexplained absence.
  if (span.status === "skipped" && research) {
    return "generating from the job description alone";
  }

  return str(span.attrs.degraded);
}

/**
 * The rows to draw, in the order they happened.
 *
 * A span with children is dropped in favour of them: `generate_questions` is one step to the
 * pipeline but four calls to a reader, and the four say more than the one. The same rule hides
 * the `generate_kit` root and the `coverage` wrapper, and it is why two coverage passes read as
 * two lines with a gap fill between them.
 */
export function toStreamRows(spans: readonly Span[]): Span[] {
  const parentIds = new Set(spans.map((span) => span.parentId).filter((id): id is string => id !== null));
  return spans.filter((span) => !parentIds.has(span.id));
}
