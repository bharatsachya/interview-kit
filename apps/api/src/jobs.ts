import {
  toErrorShape,
  type Clock,
  type IdGenerator,
  type JobRecord,
  type JobStore,
  type KitStore,
  type Span,
  type Tracer,
} from "@trao/contracts";
import type { EvaluationCase, InternalKit } from "@trao/kit";
import { generateKit, hashSubmission, type PipelineDeps } from "@trao/pipeline";

/**
 * The background job runner.
 *
 * Generation takes about a minute and a half. Holding an HTTP request open that long dies on
 * free-tier hosts, so `POST /kits` returns a job id immediately and the browser polls. That also
 * makes a run survive a closed tab and gives it a shareable URL.
 *
 * Progress is read from the tracer's own spans rather than from a hand-maintained step list. A
 * separate list would be a second source of truth about what the pipeline does, and it would be
 * wrong the first time a step was renamed.
 */

export interface JobRunnerOptions {
  jobs: JobStore;
  kits: KitStore<InternalKit>;
  ids: IdGenerator;
  clock: Clock;
  /** A fresh tracer and pipeline wiring per job — concurrent jobs must not share a trace. */
  makeDeps: () => Omit<PipelineDeps, "tracer"> & { tracer: Tracer };
  concurrency?: number;
}

/** The nine steps, for turning a span count into a percentage the UI can show. */
const PIPELINE_STEPS = [
  "extract_requirements",
  "fetch_homepage",
  "crawl_site",
  "search_discussion",
  "generate_brief",
  "generate_questions",
  "coverage",
  "derive_flashcards",
  "allocate_schedule",
] as const;

interface Running {
  tracer: Tracer;
  label: string;
}

export class JobRunner {
  readonly #running = new Map<string, Running>();
  readonly #queue: { jobId: string; userId: string; testCase: EvaluationCase }[] = [];
  #active = 0;

  constructor(private readonly options: JobRunnerOptions) {}

  /**
   * Start a job, or hand back the one already doing this exact work.
   *
   * Idempotency is by `(normalised JD + company_url + days)`. Generation is slow and expensive;
   * a double-submitted form must never pay twice.
   */
  async start(userId: string, testCase: EvaluationCase): Promise<{ jobId: string; reused: boolean }> {
    const hash = hashSubmission(testCase.jd, testCase.company_url, testCase.days);

    const existing = await this.options.kits.findByHash(hash);
    if (existing !== null && existing.userId === userId) {
      // Already generated. Hand back a job that is already complete rather than regenerating.
      const jobId = this.options.ids.next("job_");
      await this.options.jobs.create({
        id: jobId,
        userId,
        kitId: existing.id,
        status: "done",
        progress: { step: "serialize_kit", stepIndex: PIPELINE_STEPS.length, stepCount: PIPELINE_STEPS.length },
        error: null,
        createdAt: this.options.clock.now(),
        updatedAt: this.options.clock.now(),
      });
      return { jobId, reused: true };
    }

    const jobId = this.options.ids.next("job_");
    await this.options.jobs.create({
      id: jobId,
      userId,
      kitId: null,
      status: "queued",
      progress: null,
      error: null,
      createdAt: this.options.clock.now(),
      updatedAt: this.options.clock.now(),
    });

    this.#queue.push({ jobId, userId, testCase });
    this.#pump();
    return { jobId, reused: false };
  }

  /** Spans for a job still in flight. Finished jobs keep theirs until the process restarts. */
  spansFor(jobId: string): Span[] {
    return this.#running.get(jobId)?.tracer.export() ?? [];
  }

  labelFor(jobId: string): string {
    return this.#running.get(jobId)?.label ?? "";
  }

  #pump(): void {
    const limit = this.options.concurrency ?? 2;
    while (this.#active < limit && this.#queue.length > 0) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      this.#active += 1;
      void this.#run(next).finally(() => {
        this.#active -= 1;
        this.#pump();
      });
    }
  }

  async #run(entry: { jobId: string; userId: string; testCase: EvaluationCase }): Promise<void> {
    const deps = this.options.makeDeps();
    this.#running.set(entry.jobId, { tracer: deps.tracer, label: labelFor(entry.testCase) });

    // Poll our own trace to report progress. The pipeline stays unaware it is being watched.
    const ticker = setInterval(() => {
      void this.#reportProgress(entry.jobId, deps.tracer);
    }, 500);

    try {
      const result = await generateKit(
        { jd: entry.testCase.jd, companyUrl: entry.testCase.company_url, days: entry.testCase.days },
        deps,
      );

      if (result.status === "failed" || result.kit === null) {
        await this.options.jobs.fail(entry.jobId, result.error ?? { code: "INTERNAL", message: "No kit was produced." });
        return;
      }

      await this.options.kits.save({
        id: result.kit.id,
        userId: entry.userId,
        hash: result.hash,
        createdAt: result.kit.createdAt,
        updatedAt: this.options.clock.now(),
        kit: result.kit,
      });
      await this.options.jobs.complete(entry.jobId, result.kit.id);
    } catch (error) {
      // Nothing escapes a job. An unhandled rejection here would take the whole API down.
      const shape = toErrorShape(error);
      await this.options.jobs.fail(entry.jobId, { code: shape.code, message: shape.message });
    } finally {
      clearInterval(ticker);
    }
  }

  async #reportProgress(jobId: string, tracer: Tracer): Promise<void> {
    const spans = tracer.export();
    const done = PIPELINE_STEPS.filter((step) => spans.some((s) => s.step === step && s.durationMs >= 0 && s.endedAt > 0));
    const current = [...spans].reverse().find((s) => PIPELINE_STEPS.includes(s.step as (typeof PIPELINE_STEPS)[number]));

    await this.options.jobs.updateProgress(jobId, {
      step: current?.step ?? "extract_requirements",
      stepIndex: done.length,
      stepCount: PIPELINE_STEPS.length,
    });
  }
}

/** A human-readable name for a job before any kit exists to name it. */
export function labelFor(testCase: EvaluationCase): string {
  const firstLine = testCase.jd.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  if (firstLine.length > 0) return firstLine.slice(0, 80);
  try {
    return new URL(testCase.company_url).hostname;
  } catch {
    return testCase.id;
  }
}

export function isTerminal(job: JobRecord): boolean {
  return job.status === "done" || job.status === "failed";
}
