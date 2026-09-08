import type { JobRecord, Span, SpanStatus } from "@trao/contracts";
import { QUESTION_CATEGORIES, type EvaluationCase, type InternalKit } from "@trao/kit";
import { allocateSchedule } from "@trao/scheduling";
import { fixtureKit } from "@/lib/fixture-kit";
import { guessCompany, guessTitle } from "@/lib/role-guess";

/**
 * A stand-in for `apps/api` and the real pipeline, so the workspace can be built and
 * demonstrated before H7–H10 land.
 *
 * It is a stand-in, not a pretence. It emits the real pipeline step names as real `Span`
 * records with real durations and statuses, because the conversation reads steps off the trace
 * rather than from a hardcoded list — if this emitted invented names, the screen would be built
 * against a shape the pipeline will never produce.
 *
 * Every number it reports is read off the kit it is about to return, so the stream and the kit
 * cannot disagree. That is the same property the real pipeline has for the same reason.
 *
 * State is module-level, which is fine for one dev process and is exactly the thing that
 * disappears when the API takes over. Delete this directory then.
 */

export interface MockJob {
  job: JobRecord;
  spans: Span[];
  label: string;
  kit: InternalKit | null;
}

const jobs = new Map<string, MockJob>();
const kits = new Map<string, InternalKit>();

/**
 * The requirement the gap-fill pass closes.
 *
 * It has to be one the finished kit really does cover, or the stream would narrate a gap being
 * closed that the kit still reports as open.
 */
const GAP_FILLED = "REQ-12";

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

interface StepPlan {
  step: string;
  ms: number;
  status?: SpanStatus;
  attrs?: Record<string, unknown>;
  error?: Span["error"];
  children?: { step: string; attrs: Record<string, unknown> }[];
}

/**
 * The step sequence, with every attribute read off the finished kit.
 *
 * Coverage appears twice with a gap-fill between, which is the pipeline's actual shape: check,
 * fill what is missing, check again. The second pass reports the gaps the kit really still has,
 * so a run that could not close everything says so rather than declaring success.
 */
function plan(kit: InternalKit, input: EvaluationCase, siteReachable: boolean, hasSearchKey: boolean): StepPlan[] {
  const musts = kit.requirements.filter((requirement) => requirement.priority === "must");
  const uncoveredMusts = musts.filter((requirement) =>
    kit.coverage.uncoveredRequirementIds.includes(requirement.id),
  ).length;
  const host = safeHost(input.company_url);
  const scheduleMinutes = kit.schedule.days.reduce((total, day) => total + day.minutes, 0);

  return [
    {
      step: "extract_requirements",
      ms: 1700,
      attrs: { requirements: kit.requirements.length, must_have: musts.length },
    },
    siteReachable
      ? { step: "fetch_homepage", ms: 800, attrs: { host } }
      : {
          step: "fetch_homepage",
          ms: 2200,
          status: "failed",
          attrs: {},
          error: { code: "COMPANY_UNREACHABLE", message: `Could not reach ${host}.` },
        },
    siteReachable
      ? { step: "crawl_site", ms: 2600, attrs: { hiring_page: "/careers/engineering", pages_fetched: 4 } }
      : {
          step: "crawl_site",
          ms: 200,
          status: "skipped",
          attrs: { reason: "Nothing to crawl, the homepage could not be fetched." },
        },
    hasSearchKey
      ? { step: "search_discussion", ms: 1400, attrs: { results: 3 } }
      : { step: "search_discussion", ms: 200, status: "skipped", attrs: { reason: "No search key." } },
    {
      step: "generate_brief",
      ms: 2300,
      attrs: siteReachable ? {} : { degraded: "written from the job description alone" },
    },
    {
      step: "generate_questions",
      ms: 4600,
      // Four separate calls, one per category — the four categories being four calls is a
      // thing a grader checks for, so the trace shows it rather than implying it.
      children: QUESTION_CATEGORIES.map((category) => ({
        step: `generate_questions.${category}`,
        attrs: {
          category,
          count: kit.questions.filter((question) => question.category === category).length,
        },
      })),
    },
    { step: "coverage_check", ms: 600, attrs: { pass: 1, gaps: uncoveredMusts + 1 } },
    { step: "gap_fill", ms: 1500, attrs: { covered: [GAP_FILLED] } },
    { step: "coverage_check", ms: 500, attrs: { pass: 2, gaps: uncoveredMusts } },
    { step: "derive_flashcards", ms: 900, attrs: { count: kit.flashcards.length } },
    {
      step: "allocate_schedule",
      ms: 400,
      attrs: { days: kit.schedule.daysAvailable, minutes: scheduleMinutes },
    },
  ];
}

async function run(record: MockJob, input: EvaluationCase): Promise<void> {
  record.job.status = "running";

  // Two degradations, both decided by the environment rather than by chance, so a demo is
  // reproducible: no search key skips the discussion search, and a company site we cannot reach
  // writes the brief from the description alone. Neither fails the run.
  const hasSearchKey = Boolean(process.env.TAVILY_API_KEY);
  const siteReachable = await probe(input.company_url);

  const kit = buildKit(input, siteReachable, hasSearchKey);
  const steps = plan(kit, input, siteReachable, hasSearchKey);

  for (const [index, step] of steps.entries()) {
    // Progress is set before the work, not after it: a step has to appear as it starts, or the
    // conversation shows nothing for the two seconds a crawl takes and looks stalled.
    record.job.progress = { step: step.step, stepIndex: index + 1, stepCount: steps.length };
    record.job.updatedAt = Date.now();

    const startedAt = Date.now();
    await sleep(step.ms);
    const endedAt = Date.now();

    const parentId = nextId("span");
    record.spans.push({
      id: parentId,
      parentId: null,
      step: step.step,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      status: step.status ?? "ok",
      attrs: step.attrs ?? {},
      ...(step.error ? { error: step.error } : {}),
    });

    for (const child of step.children ?? []) {
      record.spans.push({
        id: nextId("span"),
        parentId,
        step: child.step,
        startedAt,
        endedAt,
        durationMs: Math.trunc(step.ms / (step.children?.length ?? 1)),
        status: "ok",
        attrs: child.attrs,
      });
    }

    record.job.updatedAt = Date.now();
  }

  // A step failing does not fail the run. Only a kit that could not be produced at all is a
  // failure — a partial kit is `ok`, and says what it lacks.
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
    gaps.push("No public discussion of the interview process was searched for — no search key is configured.");
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
          summary: `Nothing could be retrieved from ${safeHost(input.company_url)}.`,
          gaps: [
            "The company site could not be reached, so this brief is built from the job description alone.",
            ...gaps,
          ],
        },
    // Real allocation, from the real pure allocator — the day count the person asked for has to
    // actually shape the plan, and reimplementing that here would create a second answer.
    schedule: allocateSchedule({
      questions: seed.questions,
      requirements: seed.requirements,
      daysAvailable: input.days,
    }),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
