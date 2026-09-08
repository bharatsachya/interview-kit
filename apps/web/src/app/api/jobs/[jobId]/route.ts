import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getJob } from "@/lib/mock/pipeline";

/**
 * GET /api/jobs/:id — the progress screen's poll target, every two seconds.
 *
 * The spans travel with the job rather than behind a second endpoint, so the step the screen
 * names and the step the job reports can never disagree.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  await auth.protect();

  const { jobId } = await params;
  const record = getJob(jobId);
  if (!record) {
    return NextResponse.json({ code: "JOB_NOT_FOUND", message: `No job ${jobId}.` }, { status: 404 });
  }

  return NextResponse.json(
    { job: record.job, spans: record.spans, label: record.label },
    { headers: { "cache-control": "no-store" } },
  );
}
