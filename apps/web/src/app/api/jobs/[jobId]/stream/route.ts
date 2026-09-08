import { auth } from "@clerk/nextjs/server";
import { getJob } from "@/lib/mock/pipeline";

/**
 * GET /api/jobs/:id/stream — server-sent events, one per span as it closes.
 *
 * SSE rather than a socket because the traffic is one-directional and a socket would add a
 * protocol for nothing. The client falls back to polling the plain job endpoint if the stream
 * drops, which is what makes this safe to deploy on a host that buffers or kills long responses.
 *
 * Four event types: `progress` when a step begins, `span` when it finishes, `done` when the job
 * settles, and `error` if the job cannot be found. Every payload is the same shape the polling
 * endpoint returns, so the two transports produce identical state and neither is the "real" one.
 */
export const dynamic = "force-dynamic";

const TICK_MS = 200;

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  await auth.protect();
  const { jobId } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0;
      let lastProgress = -1;
      let closed = false;

      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        request.signal.removeEventListener("abort", finish);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away. Nothing to do.
        }
      };

      const tick = () => {
        if (closed) return;
        const record = getJob(jobId);
        if (!record) {
          send("error", { code: "JOB_NOT_FOUND", message: `No job ${jobId}.` });
          finish();
          return;
        }

        // A step announces itself before it runs, so a slow crawl shows as in flight rather
        // than as nothing happening.
        const progress = record.job.progress;
        if (progress && progress.stepIndex !== lastProgress) {
          lastProgress = progress.stepIndex;
          send("progress", progress);
        }

        // Spans are append-only, so "everything since last time" is a suffix. A reconnecting
        // client replays from zero, which is why the payloads carry ids the client can dedupe on.
        while (sent < record.spans.length) {
          const span = record.spans[sent];
          sent += 1;
          if (span) send("span", span);
        }

        if (record.job.status === "done" || record.job.status === "failed") {
          send("done", { job: record.job, label: record.label });
          finish();
        }
      };

      const timer = setInterval(tick, TICK_MS);
      request.signal.addEventListener("abort", finish);
      tick();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Nginx and several free hosts buffer proxied responses unless told not to; a buffered
      // stream is exactly the failure the polling fallback exists for, but this avoids it.
      "x-accel-buffering": "no",
    },
  });
}
