import type { JobRecord, Span } from "@trao/contracts";
import type { JobView } from "@trao/api-contract";
import { Unauthenticated, UpstreamUnreachable, callApi, unauthenticated, unreachable } from "@/lib/api/upstream";

/**
 * GET /api/jobs/:id/stream — server-sent events, one per span as it closes.
 *
 * The API itself has no stream endpoint, and deliberately so. Its job records and spans live in
 * the process that is running the job, which means a long-lived connection would have to land on
 * the same replica for its whole life. Polling one short request at a time survives a replica
 * being replaced mid-run; a held socket does not.
 *
 * So the fan-out happens here: this route polls the API and turns the answers into a stream for
 * the browser. One HTTP request per second per watcher, rather than one per two seconds per
 * watcher from the browser itself — barely different in load, and it gives the progress screen a
 * step announcement within a second of the step starting rather than within two.
 *
 * SSE rather than a socket because the traffic is one-directional and a socket would add a
 * protocol for nothing. The client falls back to the polling endpoint if the stream drops, which
 * is what makes this safe to deploy on a host that buffers or kills long responses.
 *
 * Four event types: `progress` when a step begins, `span` when it finishes, `done` when the job
 * settles, and `error` if the job cannot be found. Every payload is the same shape the polling
 * endpoint returns, so the two transports produce identical state and neither is the "real" one.
 */
export const dynamic = "force-dynamic";

/** One upstream request per tick, so this is a request rate and not just a timer. */
const TICK_MS = 1_000;

/**
 * How long one stream is allowed to live before it hands over to the polling fallback.
 *
 * Vercel kills a function at its plan's `maxDuration` — 60 seconds on Hobby — so on Vercel this
 * ends deliberately just short of that rather than being cut off mid-event. The client reconnects
 * once before falling back, so a 90-second run is still watched over the stream for most of its
 * life and polled for the rest. Anywhere else there is no such ceiling.
 */
const MAX_STREAM_MS = Number(process.env.STREAM_MAX_MS ?? (process.env.VERCEL ? 55_000 : 4 * 60_000));

/** Transient upstream failures are tolerated; a run of them is not. */
const MAX_CONSECUTIVE_ERRORS = 5;

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const path = `/jobs/${encodeURIComponent(jobId)}`;

  // Authenticate and confirm the job exists before opening a stream. A 404 delivered as an SSE
  // `error` event is a 200 as far as the browser is concerned, and the client would retry it.
  let first: Response;
  try {
    first = await callApi(path);
  } catch (error) {
    if (error instanceof Unauthenticated) return unauthenticated();
    if (error instanceof UpstreamUnreachable) return unreachable();
    throw error;
  }

  if (!first.ok) {
    const body = await first.text();
    return new Response(body === "" ? '{"code":"NOT_FOUND","message":"No such job."}' : body, {
      status: first.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const opening = (await first.json()) as JobView;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sent = 0;
      let lastProgress = -1;
      let closed = false;
      let errors = 0;
      const startedAt = Date.now();

      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", finish);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away. Nothing to do.
        }
      };

      request.signal.addEventListener("abort", finish);

      const emit = (view: JobView): boolean => {
        // A step announces itself before it runs, so a slow crawl shows as in flight rather
        // than as nothing happening.
        const progress = view.job.progress;
        if (progress && progress.stepIndex !== lastProgress) {
          lastProgress = progress.stepIndex;
          send("progress", progress);
        }

        // Spans are append-only, so "everything since last time" is a suffix. A reconnecting
        // client replays from zero, which is why the payloads carry ids the client dedupes on.
        while (sent < view.spans.length) {
          const span: Span | undefined = view.spans[sent];
          sent += 1;
          if (span) send("span", span);
        }

        if (settled(view.job)) {
          send("done", { job: view.job, label: view.label });
          finish();
          return true;
        }
        return false;
      };

      if (emit(opening)) return;

      while (!closed) {
        await sleep(TICK_MS);
        if (closed) return;

        if (Date.now() - startedAt > MAX_STREAM_MS) {
          // No `done` and no `error`: the client treats a silent close as the transport giving
          // up and falls back to polling, which is exactly the right outcome here.
          finish();
          return;
        }

        try {
          // Both bounds matter: the client going away should end the poll immediately, and a
          // request the API never answers should not hold the tick open indefinitely.
          const response = await callApi(path, {
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(TICK_MS * 10)]),
          });
          if (response.status === 404) {
            send("error", { code: "JOB_NOT_FOUND", message: `No job ${jobId}.` });
            finish();
            return;
          }
          if (!response.ok) throw new Error(`upstream ${response.status}`);

          errors = 0;
          if (emit((await response.json()) as JobView)) return;
        } catch {
          // The run is very likely still going; the API just missed a beat. Give up only when
          // it misses several in a row, and give up silently so the client falls back.
          errors += 1;
          if (errors >= MAX_CONSECUTIVE_ERRORS) {
            finish();
            return;
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Nginx, Azure's ingress and several free hosts buffer proxied responses unless told not
      // to; a buffered stream is exactly the failure the polling fallback exists for, but this
      // avoids it.
      "x-accel-buffering": "no",
    },
  });
}

function settled(job: JobRecord): boolean {
  return job.status === "done" || job.status === "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
