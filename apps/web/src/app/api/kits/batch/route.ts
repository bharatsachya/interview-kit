import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { parseCases } from "@trao/kit";
import { startJob } from "@/lib/mock/pipeline";

/**
 * POST /api/kits/batch — start one job per uploaded role.
 *
 * The payload is the same cases.json shape Appendix B defines, parsed by the same
 * `parseCases`. That is the whole point of accepting that shape in the UI: one parser serves
 * the upload and the batch script, and the demo writes itself.
 *
 * Ids come back in input order so the progress screen can label its rows before any kit exists.
 */
export async function POST(request: Request) {
  await auth.protect();

  const body = (await request.json().catch(() => null)) as { cases?: unknown } | null;
  const parsed = parseCases(body?.cases);
  if (!parsed.ok) {
    return NextResponse.json({ code: "INVALID_CASES", message: parsed.errors.join("; ") }, { status: 422 });
  }

  return NextResponse.json({ job_ids: parsed.cases.map(startJob) }, { status: 202 });
}
