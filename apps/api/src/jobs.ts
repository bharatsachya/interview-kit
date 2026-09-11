import {
  KitError,
  toErrorShape,
  type Clock,
  type IdGenerator,
  type JobRecord,
  type JobStore,
  type KitStore,
  type Span,
  type Tracer,
} from "@trao/contracts";
import type { RegenerateRequest } from "@trao/api-contract";
import type { EvaluationCase, InternalKit } from "@trao/kit";
import { generateKit, hashSubmission, type PipelineDeps } from "@trao/pipeline";
import type { JobSpanFeed } from "./spans";

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
 *
 * Regeneration from the builder is the same machinery: a section is smaller than a whole kit but
 * it is still several model calls, and giving it its own synchronous path would mean a second
 * answer to "is something running for this kit" and a second way for a double click to pay twice.
 */

/** Rebuild one section of an existing kit. Supplied by the composition root, like the pipeline. */
export type Regenerator = (kit: InternalKit, request: RegenerateRequest, deps: PipelineDeps) => Promise<InternalKit>;

export interface JobRunnerOptions {
  jobs: JobStore;
  kits: KitStore<InternalKit>;
  ids: IdGenerator;
  clock: Clock;
  /** A fresh tracer and pipeline wiring per job — concurrent jobs must not share a trace. */
  makeDeps: () => Omit<PipelineDeps, "tracer"> & { tracer: Tracer };
  regenerate: Regenerator;
  /** Where a running job's spans go, so `/jobs/:id/events` can replay and stream them. */
  feed: JobSpanFeed;
  concurrency?: number;
  /**
   * A hard ceiling on one run, after which the job is failed.
   *
   * The gateway already stops retrying at the run's budget deadline, and that is the mechanism
   * that should normally end a slow run. This is the backstop for everything it cannot see: a
   * socket that never closes, a crawl on a site that dribbles bytes, a bug in our own code. A
   * job that hangs is worse than a job that fails — a failure tells the user something, and the
   * screen watching it can stop.
   */
  timeoutMs?: number;
}

/** Longer than a healthy run by a wide margin, shorter than a person's patience. */
export const DEFAULT_JOB_TIMEOUT_MS = 3 * 60_000;

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

/** How often a running job's trace is read for progress and for the event stream. */
const POLL_MS = 250;

export interface StartedJob {
  jobId: string;
  kitId: string;
  /**
   * Whether this response joined work that already existed.
   *
   * True both for a resubmission of something already generated and for one that arrived while
   * the first is still running. The caller turns it into 200 rather than 202 — the distinction
   * the client cares about is "I started something" versus "here is the thing you already have".
   */
  existing: boolean;
}

interface Running {
  tracer: Tracer;
  label: string;
}

export class JobRunner {
  readonly #running = new Map<string, Running>();
  readonly #queue: (() => Promise<void>)[] = [];
  #active = 0;

  /**
   * Work in flight, keyed by what makes it the same work.
   *
   * Promises rather than ids, because the entry has to be claimed before the first `await` or
   * two requests arriving in the same tick both find it empty. Storing the promise lets the
   * loser wait for the winner's answer instead of starting its own.
   */
  readonly #creating = new Map<string, Promise<StartedJob>>();
  /** Keys join their parts with a NUL, which is the one character none of the parts can contain. */
  readonly #regenerating = new Map<string, Promise<string>>();

  constructor(private readonly options: JobRunnerOptions) {}

  /**
   * Start a generation job, or hand back the one already doing this exact work.
   *
   * Idempotency is by `(user, normalised JD + company_url + days)`. Generation is slow and
   * expensive; a double-submitted form must never pay twice.
   *
   * The kit id is reserved here rather than taken from the finished kit, because the second of
   * two identical submissions has to be answered with the id of the first and at that moment
   * there is no kit yet. Reserving it also gives the progress screen somewhere to navigate to
   * before the run ends.
   */
  async start(userId: string, testCase: EvaluationCase): Promise<StartedJob> {
    const key = `${userId}\u0000${hashSubmission(testCase.jd, testCase.company_url, testCase.days)}`;

    const pending = this.#creating.get(key);
    if (pending !== undefined) return { ...(await pending), existing: true };

    const started = this.#begin(userId, testCase, key);
    this.#creating.set(key, started);
    // A start that never got as far as queueing anything holds the key for nothing.
    void started.catch(() => this.#creating.delete(key));
    return started;
  }

  async #begin(userId: string, testCase: EvaluationCase, key: string): Promise<StartedJob> {
    const hash = hashSubmission(testCase.jd, testCase.company_url, testCase.days);

    const existing = await this.options.kits.findByHash(hash);
    if (existing !== null && existing.userId === userId) {
      // Already generated. Hand back a job that is already complete rather than regenerating.
      const jobId = this.options.ids.next("job_");
      await this.options.jobs.create({
        id: jobId,
        userId,
        label: labelFor(testCase),
        kitId: existing.id,
        status: "done",
        progress: { step: "serialize_kit", stepIndex: PIPELINE_STEPS.length, stepCount: PIPELINE_STEPS.length },
        error: null,
        createdAt: this.options.clock.now(),
        updatedAt: this.options.clock.now(),
      });
      this.options.feed.finish(jobId);
      return { jobId, kitId: existing.id, existing: true };
    }

    const jobId = this.options.ids.next("job_");
    const kitId = this.options.ids.next("kit_");
    await this.options.jobs.create({
      id: jobId,
      userId,
      label: labelFor(testCase),
      kitId,
      // Queued, not invisible. The history list reads jobs as well as kits, so a run holds its
      // place from the moment it is accepted rather than appearing only once it has a kit.
      status: "queued",
      progress: null,
      error: null,
      createdAt: this.options.clock.now(),
      updatedAt: this.options.clock.now(),
    });

    // The entry is released when the RUN ends, not when this promise resolves. Releasing it at
    // the point the job was merely created would leave a window a second or two wide in which
    // the work is plainly in flight and the map says nothing is — which is the whole window a
    // double-clicked button lives in. Afterwards the store's `findByHash` is the better answer:
    // it survives a restart, and a failed run is not remembered as a success.
    this.#enqueue(() => this.#runGeneration({ jobId, kitId, userId, testCase, hash }), () => this.#creating.delete(key));
    return { jobId, kitId, existing: false };
  }

  /**
   * Rebuild one section of a kit, or join the run already doing it.
   *
   * Keyed on kit + section + category, which is the unit the button represents. Two clicks on
   * Regenerate get the same job id and one set of model calls; regenerating the behavioural
   * questions while the technical ones are still going is a different key and runs alongside.
   *
   * The caller has already proved the kit is this user's — ownership is not rechecked here,
   * because a runner that could load any kit by id is a runner that can be asked to.
   */
  regenerate(userId: string, kitId: string, request: RegenerateRequest): Promise<{ jobId: string; existing: boolean }> {
    const key = `${kitId}\u0000${request.section}\u0000${request.category ?? ""}`;

    const pending = this.#regenerating.get(key);
    if (pending !== undefined) return pending.then((jobId) => ({ jobId, existing: true }));

    const started = this.#beginRegeneration(userId, kitId, request, key);
    this.#regenerating.set(key, started);
    void started.catch(() => this.#regenerating.delete(key));
    return started.then((jobId) => ({ jobId, existing: false }));
  }

  async #beginRegeneration(
    userId: string,
    kitId: string,
    request: RegenerateRequest,
    key: string,
  ): Promise<string> {
    const jobId = this.options.ids.next("job_");
    await this.options.jobs.create({
      id: jobId,
      userId,
      label: regenerationLabel(request),
      kitId,
      status: "queued",
      progress: null,
      error: null,
      createdAt: this.options.clock.now(),
      updatedAt: this.options.clock.now(),
    });

    // Held until the regeneration is over — see `#begin`. This is the entry that makes a second
    // click on Regenerate cost nothing.
    this.#enqueue(() => this.#runRegeneration({ jobId, kitId, userId, request }), () => this.#regenerating.delete(key));
    return jobId;
  }

  /** Spans for a job still in flight. Finished jobs keep theirs until the process restarts. */
  spansFor(jobId: string): Span[] {
    const live = this.#running.get(jobId)?.tracer.export();
    // A finished job has no tracer any more, but the feed kept everything it published.
    return live ?? this.options.feed.snapshot(jobId);
  }

  /** In-process label for a running job; the stored one on the record is the durable answer. */
  labelFor(jobId: string): string {
    return this.#running.get(jobId)?.label ?? "";
  }

  /** Queue work, and release whatever was claimed on its behalf once it is over, however it ends. */
  #enqueue(work: () => Promise<void>, release: () => void): void {
    this.#queue.push(async () => {
      try {
        await work();
      } finally {
        release();
      }
    });
    this.#pump();
  }

  #pump(): void {
    const limit = this.options.concurrency ?? 2;
    while (this.#active < limit && this.#queue.length > 0) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      this.#active += 1;
      void next().finally(() => {
        this.#active -= 1;
        this.#pump();
      });
    }
  }

  async #runGeneration(entry: {
    jobId: string;
    kitId: string;
    userId: string;
    testCase: EvaluationCase;
    hash: string;
  }): Promise<void> {
    await this.#traced(entry.jobId, labelFor(entry.testCase), PIPELINE_STEPS, async (deps, settle) => {
      const result = await generateKit(
        { jd: entry.testCase.jd, companyUrl: entry.testCase.company_url, days: entry.testCase.days },
        deps,
      );

      settle();
      if (result.status === "failed" || result.kit === null) {
        await this.options.jobs.fail(entry.jobId, result.error ?? { code: "INTERNAL", message: "No kit was produced." });
        return;
      }

      // The id the pipeline minted is discarded in favour of the one already promised to the
      // client. The pipeline cannot be handed the id instead: it is the batch path's writer too,
      // and batch has no request to promise anything to.
      const kit: InternalKit = { ...result.kit, id: entry.kitId };
      await this.options.kits.save({
        id: kit.id,
        userId: entry.userId,
        hash: result.hash,
        createdAt: kit.createdAt,
        updatedAt: this.options.clock.now(),
        kit,
      });
      await this.options.jobs.complete(entry.jobId, kit.id);
    });
  }

  async #runRegeneration(entry: {
    jobId: string;
    kitId: string;
    userId: string;
    request: RegenerateRequest;
  }): Promise<void> {
    await this.#traced(entry.jobId, regenerationLabel(entry.request), null, async (deps, settle) => {
      const record = await this.options.kits.findById(entry.kitId);
      if (record === null || record.userId !== entry.userId) {
        // Deleted, or reassigned, between the click and the job reaching the front of the queue.
        settle();
        await this.options.jobs.fail(entry.jobId, { code: "INVALID_INPUT", message: "The kit is no longer available." });
        return;
      }

      // The regenerator's new question and flashcard ids must be unique against a document that
      // already holds q1..qN plus everything ever archived. A per-run sequential generator —
      // which is what `makeDeps` builds under `--fake-llm`, so the trace reads r1/q1/f1 — starts
      // from scratch on every job and would hand back ids the kit is already using. The runner's
      // own generator is the one that mints ids for things that outlive a run.
      const kit = await this.options.regenerate(record.kit, entry.request, { ...deps, ids: this.options.ids });
      settle();

      // Written back under the version the regeneration produced. An edit that landed while the
      // section was rebuilding is already inside `kit` — the regenerator was handed the record as
      // it was when the job started, so the last writer wins here, and that writer is the machine.
      // This is the one place where that is the right answer: the user asked for this section to
      // be replaced, and anything of theirs inside it survives on provenance, not on timing.
      await this.options.kits.save({ ...record, kit, updatedAt: this.options.clock.now() });
      await this.options.jobs.complete(entry.jobId, kit.id);
    });
  }

  /**
   * Run one job: fresh wiring, a ticker feeding progress and the event stream, and a guarantee
   * that nothing escapes. An unhandled rejection in here would take the whole API down.
   */
  async #traced(
    jobId: string,
    label: string,
    steps: readonly string[] | null,
    work: (deps: Omit<PipelineDeps, "tracer"> & { tracer: Tracer }, settle: () => void) => Promise<void>,
  ): Promise<void> {
    const deps = this.options.makeDeps();
    this.#running.set(jobId, { tracer: deps.tracer, label });

    /**
     * Progress reporting stops the moment the job has an outcome.
     *
     * `updateProgress` puts a job back into `running` — that is what it means. A tick landing
     * after `complete` would therefore un-finish a finished job, and the screen watching it
     * would poll forever. So the work says when it is about to record an outcome, and the
     * ticker goes quiet from that point even though it is still running.
     */
    let settled = false;
    const settle = (): void => {
      settled = true;
    };

    // Poll our own trace. The pipeline stays unaware it is being watched.
    const ticker = setInterval(() => {
      this.options.feed.publish(jobId, deps.tracer.export());
      if (!settled) void this.#reportProgress(jobId, deps.tracer, steps);
    }, POLL_MS);

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

    try {
      await withTimeout(work(deps, settle), timeoutMs);
    } catch (error) {
      settle();
      const shape = toErrorShape(error);
      await this.options.jobs.fail(jobId, { code: shape.code, message: shape.message });
    } finally {
      clearInterval(ticker);
      // One last publish, so the span that finished between the final tick and here is not lost.
      this.options.feed.publish(jobId, deps.tracer.export());
      this.options.feed.finish(jobId);
      this.#running.delete(jobId);
    }
  }

  /**
   * Turn the trace into the two numbers a progress bar needs.
   *
   * `steps` is the expected list when there is one — generation always runs the same nine. A
   * regeneration's shape depends on the section, so it passes null and the count comes from the
   * spans themselves: it can only ever grow, which reads as a bar that slows down rather than
   * one that lies about being nearly finished.
   */
  async #reportProgress(jobId: string, tracer: Tracer, steps: readonly string[] | null): Promise<void> {
    const spans = tracer.export();
    const relevant = steps === null ? topLevel(spans) : spans.filter((s) => steps.includes(s.step));

    const done = relevant.filter((s) => s.status !== "running");
    const current = [...relevant].reverse().find((s) => s.status === "running") ?? relevant[relevant.length - 1];

    await this.options.jobs.updateProgress(jobId, {
      step: current?.step ?? steps?.[0] ?? "starting",
      stepIndex: new Set(done.map((s) => s.step)).size,
      stepCount: steps === null ? Math.max(relevant.length, 1) : steps.length,
    });
  }
}

/** The spans a reader thinks of as steps: the direct children of the run's root span. */
function topLevel(spans: readonly Span[]): Span[] {
  const roots = new Set(spans.filter((s) => s.parentId === null).map((s) => s.id));
  const children = spans.filter((s) => s.parentId !== null && roots.has(s.parentId));
  return children.length > 0 ? children : spans.filter((s) => s.parentId === null);
}

/**
 * Reject when the work outlasts its ceiling.
 *
 * The pipeline keeps running in the background after this rejects — there is no way to abort a
 * fetch already in flight from out here — but the job is marked failed and the screen watching
 * it stops. A run nobody is waiting for finishing quietly is a much smaller problem than a
 * screen that never changes.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new KitError("TIMEOUT", `The run passed its ${Math.round(ms / 1000)}s limit and was stopped.`, {
                details: { timeoutMs: ms },
              }),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

function regenerationLabel(request: RegenerateRequest): string {
  if (request.section === "questions") return `Regenerating ${request.category ?? ""} questions`.replace(/\s+/g, " ");
  return request.section === "company_brief" ? "Regenerating the company brief" : "Regenerating the schedule";
}

export function isTerminal(job: JobRecord): boolean {
  return job.status === "done" || job.status === "failed";
}
