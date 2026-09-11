import { proxyJson } from "@/lib/api/upstream";

/**
 * `/api/jobs/:jobId/retry` — run a failed job's work again.
 *
 * A POST with no body: everything the retry needs is already on the job record, which is the
 * point of storing it. The browser has nothing to send — after a reload the posting that
 * started the run is long gone from the page.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return proxyJson(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
}
