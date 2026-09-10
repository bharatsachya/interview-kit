import { proxyJson } from "@/lib/api/upstream";

/**
 * GET /api/jobs/:id — the progress screen's poll target, and the fallback the stream degrades
 * to.
 *
 * The spans travel with the job rather than behind a second endpoint, so the step the screen
 * names and the step the job reports can never disagree.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return proxyJson(`/jobs/${encodeURIComponent(jobId)}`);
}
