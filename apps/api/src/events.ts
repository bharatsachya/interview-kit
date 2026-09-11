import { Router, type Response } from "express";
import type { JobStore, Span } from "@trao/contracts";
import type { Authenticator } from "@trao/auth";
import { guarded, notFound } from "./http";
import { isTerminal, type JobRunner } from "./jobs";
import type { JobSpanFeed } from "./spans";

/**
 * `GET /jobs/:id/events` — the run, as it happens.
 *
 * ## Why this exists next to polling rather than instead of it
 *
 * `GET /jobs/:id` is still the mechanism the progress screen uses, because free hosts buffer
 * streams and a progress bar that stalls behind a proxy is worse than one that ticks every two
 * seconds. This endpoint is the better answer where the stream survives: it delivers a step the
 * moment it finishes instead of up to two seconds later, and it costs one connection rather than
 * a request every two seconds for ninety seconds. Both read the same spans from the same feed,
 * so they can never disagree about what the run has done.
 *
 * ## Replay first, then live
 *
 * A client almost never connects at the moment a job starts. It reloads the page, it comes back
 * from another tab, it opens a link somebody sent. A stream that only carried what happened next
 * would leave such a client staring at nothing for the length of the longest step, and would make
 * a reload strictly worse than not reloading. So the connection opens by replaying every span the
 * job has recorded, in order, and only then attaches to the live feed — see `JobSpanFeed`, where
 * the two are done under one call so a span cannot fall between them.
 */

export interface EventDeps {
  auth: Authenticator;
  jobs: JobStore;
  runner: JobRunner;
  feed: JobSpanFeed;
  /** Comment frames keep an idle connection open through proxies that reap quiet sockets. */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export function eventRoutes(deps: EventDeps): Router {
  const router = Router();

  router.get(
    "/jobs/:jobId/events",
    guarded(deps.auth, async (req, res, userId) => {
      const jobId = req.params["jobId"] ?? "";
      const job = await deps.jobs.findById(jobId);
      // 404 rather than 403 for someone else's job, for the same reason as kits: confirming it
      // exists is itself the leak.
      if (job === null || job.userId !== userId) return notFound(res, "job");

      res.status(200).set({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        // Nginx and friends buffer by default, which turns a stream into one long pause
        // followed by everything at once.
        "x-accel-buffering": "no",
      });
      res.flushHeaders();

      // The runner may have finished and dropped its tracer before anyone connected; the feed
      // still holds what it published, so a job watched after the fact replays in full.
      deps.feed.publish(jobId, deps.runner.spansFor(jobId));

      // Declared before `end` closes over them: the already-finished path below calls `end`
      // before the heartbeat is started, and a `const` read from the temporal dead zone would
      // throw rather than close the stream.
      let open = true;
      let heartbeat: NodeJS.Timeout | undefined;
      const end = (): void => {
        if (!open) return;
        open = false;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
        res.end();
      };

      const unsubscribe = deps.feed.subscribe(jobId, {
        onSpan: (span) => {
          if (open) writeEvent(res, "step", stepPayload(span));
        },
        onEnd: () => {
          void (async () => {
            // Re-read rather than trusting the record we loaded: it is by now a minute old, and
            // the client's next move depends on whether this run produced a kit.
            const settled = await deps.jobs.findById(jobId);
            if (open) {
              writeEvent(res, "done", {
                status: settled?.status ?? job.status,
                kit_id: settled?.kitId ?? null,
                error: settled?.error ?? null,
              });
            }
            end();
          })();
        },
      });

      // A job that was already over when the request arrived: `subscribe` has replayed its spans
      // and called `onEnd`, so there is nothing left to do. A job whose record is terminal but
      // whose feed never saw a `finish` — the process restarted mid-run — would otherwise hang.
      if (isTerminal(job) && !deps.feed.isFinished(jobId)) {
        writeEvent(res, "done", { status: job.status, kit_id: job.kitId, error: job.error });
        end();
        return;
      }

      heartbeat = setInterval(() => {
        if (open) res.write(": keep-alive\n\n");
      }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

      // The browser navigating away is the normal way this ends. Without this the listener and
      // the timer outlive the socket, and a long-lived API accumulates both.
      req.on("close", end);
    }),
  );

  return router;
}

/**
 * One span, as the screen needs it.
 *
 * The attributes come along because they are what makes the trace worth showing — "crawl_site,
 * 7 pages fetched, 2 skipped" rather than a bar moving. They are ours, not the model's, and
 * carry nothing a user typed.
 */
function stepPayload(span: Span): Record<string, unknown> {
  return {
    id: span.id,
    parent_id: span.parentId,
    step: span.step,
    status: span.status,
    started_at: span.startedAt,
    duration_ms: span.status === "running" ? null : span.durationMs,
    attrs: span.attrs,
    ...(span.error !== undefined ? { error: span.error } : {}),
  };
}

function writeEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
