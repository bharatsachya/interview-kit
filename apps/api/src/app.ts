import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import type { CreateJobsResponse, CreateKitResponse, JobListView, KitListView } from "@trao/api-contract";
import {
  isKitError,
  type Clock,
  type IdGenerator,
  type JobStore,
  type KitStore,
  type PracticeStore,
} from "@trao/contracts";
import { isAuthError, type Authenticator } from "@trao/auth";
import { parseCases, type EvaluationCase, type InternalKit } from "@trao/kit";
import { builderRoutes } from "./builder";
import { eventRoutes } from "./events";
import { practiceRoutes } from "./practice";
import { guarded, notFound, unauthenticated } from "./http";
import type { JobRunner } from "./jobs";
import { createKitSchema, parseBody } from "./schemas";
import type { JobSpanFeed } from "./spans";

/**
 * The Express API.
 *
 * Thin on purpose: every route authenticates, validates, delegates, and shapes a response.
 * There is no domain logic here — the pipeline, the kit projections and the state transitions
 * all live in packages that this app merely wires together.
 *
 * Ownership is enforced on every read. A kit id is not a secret, and "users see only their own
 * kits" has to be a check rather than a convention.
 *
 * The builder's fourteen routes are in `builder.ts` and the event stream is in `events.ts`, for
 * no better reason than that one file of twenty routes stops being readable. What is here is the
 * composition: creating work, listing it, and the one error handler everything falls through to.
 */

export interface ApiOptions {
  auth: Authenticator;
  jobs: JobStore;
  kits: KitStore<InternalKit>;
  practice: PracticeStore;
  runner: JobRunner;
  feed: JobSpanFeed;
  ids: IdGenerator;
  clock: Clock;
  corsOrigins?: string[];
  /** Passed through to the event stream so tests do not wait fifteen seconds for a keep-alive. */
  heartbeatMs?: number;
}

export function createApp(options: ApiOptions): express.Express {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(
    cors({
      origin: options.corsOrigins ?? true,
      credentials: true,
      // The builder's concurrency control travels in these two, and a cross-origin client
      // cannot read a response header it was not offered.
      allowedHeaders: ["authorization", "content-type", "if-match"],
      exposedHeaders: ["etag"],
    }),
  );

  // Unauthenticated, so a platform health check does not need a token.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * Start one generation, or hand back the one already doing this exact work.
   *
   * 202 with a job id and the kit id it will occupy; 200 when the answer already existed. The
   * kit id is in both, so a double-submitted form has one destination rather than two.
   */
  app.post(
    "/kits",
    guarded(options.auth, async (req, res, userId) => {
      const parsed = parseBody(createKitSchema, req.body);
      if (!parsed.ok) return void res.status(400).json(parsed.error);

      const testCase: EvaluationCase = { id: options.ids.next("case_"), ...parsed.value };
      const started = await options.runner.start(userId, testCase);

      res.status(started.existing ? 200 : 202).json({
        job_id: started.jobId,
        kit_id: started.kitId,
        existing: started.existing,
        job_ids: [started.jobId],
      } satisfies CreateKitResponse);
    }),
  );

  app.post(
    "/kits/batch",
    guarded(options.auth, async (req, res, userId) => {
      const body = req.body as { cases?: unknown };
      const parsed = parseCases(body.cases);
      if (!parsed.ok) {
        res.status(422).json({ code: "INVALID_CASES", message: parsed.errors.join("; ") });
        return;
      }

      // Started in input order so the rows can be labelled before any kit exists.
      const jobIds: string[] = [];
      for (const testCase of parsed.cases) {
        const { jobId } = await options.runner.start(userId, testCase);
        jobIds.push(jobId);
      }

      res.status(202).json({ job_ids: jobIds } satisfies CreateJobsResponse);
    }),
  );

  app.get(
    "/jobs",
    guarded(options.auth, async (_req, res, userId) => {
      // Everything the user has run, finished or not. A queued job appears here immediately,
      // which is what lets the history list survive navigating away mid-run.
      const jobs = await options.jobs.listByUser(userId);
      res.set("cache-control", "no-store").json({
        jobs: jobs.map((job) => ({
          id: job.id,
          label: job.label,
          status: job.status,
          kitId: job.kitId,
          createdAt: job.createdAt,
          progress: job.progress,
          error: job.error,
          // Whether this one can be run again, rather than leaving the client to infer it from
          // a status and be wrong about the records written before the posting was stored.
          retryable: job.status === "failed" && (job.request ?? null) !== null,
        })),
      } satisfies JobListView);
    }),
  );

  app.post(
    "/jobs/:jobId/retry",
    guarded(options.auth, async (req, res, userId) => {
      const started = await options.runner.retry(userId, req.params["jobId"] as string);
      // One 404 for "no such job", "not yours", "did not fail" and "nothing to retry with".
      // The first two must not be distinguishable — confirming a job exists leaks that it does
      // — and the last two are only reachable by a client ignoring what the list already told
      // it, so there is nothing to gain from telling them apart.
      if (started === null) return notFound(res, "job");

      res.status(202).json({ job_ids: [started.jobId] } satisfies CreateJobsResponse);
    }),
  );

  app.get(
    "/jobs/:jobId",
    guarded(options.auth, async (req, res, userId) => {
      const job = await options.jobs.findById(req.params["jobId"] as string);
      // 404 rather than 403 for someone else's job: confirming it exists leaks that it does.
      if (job === null || job.userId !== userId) return notFound(res, "job");

      const { request: jobRequest, ...rest } = job;
      res.set("cache-control", "no-store").json({
        job: { ...rest, retryable: job.status === "failed" && (jobRequest ?? null) !== null },
        spans: options.runner.spansFor(job.id),
        // The in-process label while the job is running, the stored one otherwise — a job
        // watched after a restart still has a name, it just no longer has live spans.
        label: options.runner.labelFor(job.id) || job.label,
      });
    }),
  );

  app.use(eventRoutes({ auth: options.auth, jobs: options.jobs, runner: options.runner, feed: options.feed, ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}) }));

  app.get(
    "/kits",
    guarded(options.auth, async (_req, res, userId) => {
      const records = await options.kits.listByUser(userId);
      res.set("cache-control", "no-store").json({
        kits: records.map((record) => ({
          id: record.id,
          title: record.kit.role.title,
          company: record.kit.role.company,
          days: record.kit.schedule.daysAvailable,
          createdAt: record.createdAt,
        })),
      } satisfies KitListView);
    }),
  );

  // Before the builder, because a rating is not an edit: no version, no `If-Match`, and two
  // tabs rating the same card do not conflict.
  app.use(
    practiceRoutes({
      auth: options.auth,
      kits: options.kits,
      practice: options.practice,
      ids: options.ids,
      clock: options.clock,
    }),
  );

  // Last, because `/kits/:kitId` would otherwise shadow `/kits/batch`.
  app.use(
    builderRoutes({
      auth: options.auth,
      kits: options.kits,
      runner: options.runner,
      ids: options.ids,
      clock: options.clock,
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: "No such route." });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    // The only error the API layer produces on purpose. Its code is what the UI branches on:
    // an expired session gets sent back to sign-in, anything else gets the generic page.
    if (isAuthError(error)) return unauthenticated(res, error);

    if (isKitError(error)) {
      // A kit that fails its own Appendix A validation on the way out is our bug, not the
      // caller's — but the code is worth naming so the failure is legible in a log.
      process.stderr.write(`kit error: ${error.code} ${error.message}\n`);
      return void res.status(500).json({ code: error.code, message: "The kit could not be produced." });
    }

    // Nothing internal reaches the client. The message could name a file path or a query.
    process.stderr.write(`unhandled: ${error instanceof Error ? error.stack : String(error)}\n`);
    res.status(500).json({ code: "INTERNAL", message: "Something went wrong." });
  });

  return app;
}
