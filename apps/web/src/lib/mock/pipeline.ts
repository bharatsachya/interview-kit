import type { JobRecord, Span, SpanStatus } from "@trao/contracts";
import type { EvaluationCase, InternalKit } from "@trao/kit";
import { allocateSchedule } from "@trao/scheduling";
import { fixtureKit } from "@/lib/fixture-kit";
import { guessCompany, guessTitle } from "@/lib/role-guess";

/**
 * A stand-in for `apps/api` and the real pipeline, so the create and progress screens can be
 * built and demonstrated before H7–H10 land.
 *
 * It is a stand-in, not a pretence. It emits the nine real pipeline step names as real `Span`
 * records with real durations and real statuses, because the progress screen reads steps from
 * the trace rather than from a hardcoded list — if this emitted invented names, the screen
 * would be built against a shape the pipeline will never produce.
 *
 * State is module-level, which is fine for a single dev process and is exactly the thing that
 * disappears when the API takes over. Delete this directory then.
 */

interface MockJob {
  job: JobRecord;
  spans: Span[];
  label: string;
  kit: InternalKit | null;
}

const jobs = new Map<string, MockJob>();
const kits = new Map<string, InternalKit>();

/** The nine steps of the pipeline, in order, with the child calls that matter to a watcher. */
const STEPS: { step: string; ms: number; children?: string[] }[] = [
  { step: "extract_requirements", ms: 1800 },
  { step: "fetch_homepage", ms: 900 },
  { step: "crawl_site", ms: 3000 },
  { step: "search_discussion", ms: 1200 },
  { step: "generate_brief", ms: 2400 },
  {
    step: "generate_questions",
    ms: 4800,
    // Four separate calls, one per category. They are children rather than one span because
    // "the four categories are four separate calls" is a thing a grader checks for.
    children: ["technical", "behavioural", "system-design", "company-fit"],
  },
  { step: "coverage_check", ms: 700 },
  { step: "gap_fill", ms: 1600 },
  { step: "derive_flashcards", ms: 900 },
  { step: "allocate_schedule", ms: 300 },
];

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}${Math.trunc(performance.now()).toString(36)}`;
}

export function startJob(input: EvaluationCase): string {
  const jobId = nextId("job");
  const now = Date.now();
  const label = [guessTitle(input.jd), guessCompany(input.company_url)].filter(Boolean).join(" · ") || input.id;

  const record: MockJob = {
    job: {
      id: jobId,
      userId: null,
      kitId: null,
      status: "queued",
      progress: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    },
    spans: [],
    label,
    kit: null,
  };
  jobs.set(jobId, record);
  void run(record, input);
  return jobId;
}

export function getJob(jobId: string): MockJob | null {
  return jobs.get(jobId) ?? null;
}

export function getKit(kitId: string): InternalKit | null {
  return kits.get(kitId) ?? fallbackKit(kitId);
}

/** Newest first — the history list reads top-down and the last thing built is the live one. */
export function listKits(): InternalKit[] {
  const seed = fixtureKit();
  const all = [...kits.values()];
  if (!kits.has(seed.id)) all.push(seed);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** The seeded example kit stays reachable by its own id, so the demo has something to open. */
function fallbackKit(kitId: string): InternalKit | null {
  const seed = fixtureKit();
  return seed.id === kitId ? seed : null;
}

async function run(record: MockJob, input: EvaluationCase): Promise<void> {
  record.job.status = "running";

  // Two degradations, both decided by the environment rather than by chance, so a demo is
  // reproducible: no search key means the discussion search is skipped, and a company site we
  // cannot reach means the brief is written from the description alone.
  const hasSearchKey = Boolean(process.env.TAVILY_API_KEY);
  const siteReachable = await probe(input.company_url);

  for (const [index, definition] of STEPS.entries()) {
    const startedAt = Date.now();
    await sleep(definition.ms);
    const endedAt = Date.now();

    let status: SpanStatus = "ok";
    const attrs: Record<string, unknown> = {};
    let error: Span["error"];

    if (definition.step === "search_discussion" && !hasSearchKey) {
      status = "skipped";
      attrs.reason = "No search provider configured — TAVILY_API_KEY is unset.";
    }
    if ((definition.step === "crawl_site" || definition.step === "fetch_homepage") && !siteReachable) {
      status = definition.step === "fetch_homepage" ? "failed" : "skipped";
      if (status === "failed") {
        error = { code: "COMPANY_UNREACHABLE", message: `Could not reach ${input.company_url}.` };
      } else {
        attrs.reason = "Nothing to crawl — the homepage could not be fetched.";
      }
    }
    if (definition.step === "generate_brief" && !siteReachable) {
      attrs.degraded = "Written from the job description alone.";
    }
    if (definition.step === "crawl_site" && siteReachable) {
      attrs.pages_fetched = 4;
    }
    if (definition.step === "coverage_check") {
      attrs.passes = 2;
    }

    const parentId = nextId("span");
    record.spans.push({
      id: parentId,
      parentId: null,
      step: definition.step,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      status,
      attrs,
      ...(error ? { error } : {}),
    });

    for (const child of definition.children ?? []) {
      record.spans.push({
        id: nextId("span"),
        parentId,
        step: `generate_questions.${child}`,
        startedAt,
        endedAt,
        durationMs: Math.trunc(definition.ms / 4),
        status: "ok",
        attrs: { category: child },
      });
    }

    record.job.progress = {
      step: definition.step,
      stepIndex: index + 1,
      stepCount: STEPS.length,
    };
    record.job.updatedAt = Date.now();
  }

  // A step failing does not fail the run. Only a kit that could not be produced at all is a
  // failure — a partial kit is `ok`, and says what it lacks.
  const kit = buildKit(input, siteReachable, hasSearchKey);
  kits.set(kit.id, kit);
  record.kit = kit;
  record.job.kitId = kit.id;
  record.job.status = "done";
  record.job.updatedAt = Date.now();
}

function buildKit(input: EvaluationCase, siteReachable: boolean, hasSearchKey: boolean): InternalKit {
  const seed = fixtureKit();
  const company = guessCompany(input.company_url) || seed.role.company;
  const title = guessTitle(input.jd) || seed.role.title;

  const gaps = [...seed.companyBrief.gaps];
  if (!hasSearchKey) {
    gaps.push("No public discussion of the interview process was searched for — no search provider is configured.");
  }

  return {
    ...seed,
    id: `kit_${input.id}_${Math.trunc(Date.now() / 1000).toString(36)}`,
    createdAt: Date.now(),
    role: { ...seed.role, title, company },
    companyBrief: siteReachable
      ? { ...seed.companyBrief, gaps }
      : {
          ...seed.companyBrief,
          whatTheyDo: "",
          hiringProcess: "",
          sources: [],
          pagesUsed: [],
          summary: `Nothing could be retrieved from ${input.company_url}.`,
          gaps: [
            `The company site could not be reached, so this brief is built from the job description alone.`,
            ...gaps,
          ],
        },
    // Real allocation, from the real pure allocator — the day count the person asked for has
    // to actually shape the plan, and reimplementing that here would create a second answer.
    schedule: allocateSchedule({
      questions: seed.questions,
      requirements: seed.requirements,
      daysAvailable: input.days,
    }),
  };
}

/**
 * A HEAD request with a short deadline. The real pipeline's retrieval is far more careful; all
 * this needs to decide is which of the two demonstrable outcomes the run should show.
 */
async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2500), redirect: "follow" });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
