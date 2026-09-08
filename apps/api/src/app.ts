import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import type { CreateJobsResponse, KitListView, KitView } from "@trao/api-contract";
import { isKitError, type JobStore, type KitStore } from "@trao/contracts";
import type { Authenticator } from "@trao/auth";
import { getKitForBuilder, parseCases, type EvaluationCase, type InternalKit } from "@trao/kit";
import type { JobRunner } from "./jobs";

/**
 * The Express API.
 *
 * Thin on purpose: every route authenticates, validates, delegates, and shapes a response.
 * There is no domain logic here — the pipeline, the kit projections and the state transitions
 * all live in packages that this app merely wires together.
 *
 * Ownership is enforced on every read. A kit id is not a secret, and "users see only their own
 * kits" has to be a check rather than a convention.
 */

export interface ApiOptions {
  auth: Authenticator;
  jobs: JobStore;
  kits: KitStore<InternalKit>;
  runner: JobRunner;
  corsOrigins?: string[];
}

export function createApp(options: ApiOptions): express.Express {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(
    cors({
      origin: options.corsOrigins ?? true,
      credentials: true,
    }),
  );

  // Unauthenticated, so a platform health check does not need a token.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    "/kits",
    guarded(options, async (req, res, userId) => {
      const parsed = parseCases([{ id: `role-${Date.now().toString(36)}`, ...(req.body as object) }]);
      if (!parsed.ok) {
        res.status(422).json({ code: "INVALID_ROLE", message: parsed.errors.join("; ") });
        return;
      }

      const only = parsed.cases[0] as EvaluationCase;
      const { jobId } = await options.runner.start(userId, only);
      res.status(202).json({ job_ids: [jobId] } satisfies CreateJobsResponse);
    }),
  );

  app.post(
    "/kits/batch",
    guarded(options, async (req, res, userId) => {
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
    "/jobs/:jobId",
    guarded(options, async (req, res, userId) => {
      const job = await options.jobs.findById(req.params["jobId"] as string);
      // 404 rather than 403 for someone else's job: confirming it exists leaks that it does.
      if (job === null || job.userId !== userId) {
        res.status(404).json({ code: "NOT_FOUND", message: "No such job." });
        return;
      }

      res.set("cache-control", "no-store").json({
        job,
        spans: options.runner.spansFor(job.id),
        label: options.runner.labelFor(job.id),
      });
    }),
  );

  app.get(
    "/kits",
    guarded(options, async (_req, res, userId) => {
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

  app.get(
    "/kits/:kitId",
    guarded(options, async (req, res, userId) => {
      const record = await options.kits.findById(req.params["kitId"] as string);
      if (record === null || record.userId !== userId) {
        res.status(404).json({ code: "NOT_FOUND", message: "No such kit." });
        return;
      }

      // The builder projection: active items only, provenance flags intact, schedule repaired.
      res.set("cache-control", "no-store").json({ kit: getKitForBuilder(record.kit) } satisfies KitView);
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: "No such route." });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isKitError(error) && error.details["status"] === 401) {
      res.status(401).json({ code: "UNAUTHENTICATED", message: error.message });
      return;
    }
    // Nothing internal reaches the client. The message could name a file path or a query.
    process.stderr.write(`unhandled: ${error instanceof Error ? error.stack : String(error)}\n`);
    res.status(500).json({ code: "INTERNAL", message: "Something went wrong." });
  });

  return app;
}

/**
 * Authenticate, then run the handler.
 *
 * Wrapping rather than `app.use` middleware so no route can be added without one: a route that
 * forgets to authenticate is a route that does not compile, because the handler signature
 * demands a `userId`.
 */
function guarded(
  options: ApiOptions,
  handler: (req: Request, res: Response, userId: string) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void (async () => {
      try {
        const user = await options.auth.authenticate(req.header("authorization"));
        await handler(req, res, user.id);
      } catch (error) {
        next(error);
      }
    })();
  };
}
