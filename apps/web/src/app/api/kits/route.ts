import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { parseCases } from "@trao/kit";
import { listKits, startJob } from "@/lib/mock/pipeline";

/** GET /api/kits — the history sidebar's list. Newest first. */
export async function GET() {
  await auth.protect();

  return NextResponse.json(
    {
      kits: listKits().map((kit) => ({
        id: kit.id,
        title: kit.role.title,
        company: kit.role.company,
        days: kit.schedule.daysAvailable,
        createdAt: kit.createdAt,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * POST /api/kits — start one generation job.
 *
 * Returns a job id immediately. Generation takes about a minute and a half; a request held
 * open that long dies on free-tier hosts, and a job id is also what makes the run survive a
 * closed tab and gives it a shareable URL.
 *
 * The body is validated by wrapping it into an Appendix B case and running the same parser the
 * batch upload and `scripts/evaluate.ts` use. One definition of "a valid role to generate for".
 */
export async function POST(request: Request) {
  await auth.protect();

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) {
    return NextResponse.json({ code: "BAD_REQUEST", message: "Body must be JSON." }, { status: 400 });
  }

  const parsed = parseCases([{ id: `role-${Date.now().toString(36)}`, ...body }]);
  if (!parsed.ok) {
    return NextResponse.json(
      { code: "INVALID_ROLE", message: parsed.errors.join("; ") },
      { status: 422 },
    );
  }

  const [only] = parsed.cases;
  if (!only) {
    return NextResponse.json({ code: "INVALID_ROLE", message: "No role in body." }, { status: 422 });
  }

  return NextResponse.json({ job_ids: [startJob(only)] }, { status: 202 });
}
