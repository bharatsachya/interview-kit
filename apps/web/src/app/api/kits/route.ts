import { forwardBody, proxyJson } from "@/lib/api/upstream";

/**
 * `/api/kits` — the history sidebar's list, and starting one generation job.
 *
 * Both forward straight to `apps/api`. The body is not parsed here: `POST /kits` on the API
 * already runs it through the same `parseCases` the batch script uses, and validating in two
 * places is how the two answers start disagreeing about what a valid role is.
 */

export async function GET() {
  return proxyJson("/kits");
}

export async function POST(request: Request) {
  return proxyJson("/kits", { method: "POST", body: await forwardBody(request) });
}
