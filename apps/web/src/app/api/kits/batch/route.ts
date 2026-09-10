import { forwardBody, proxyJson } from "@/lib/api/upstream";

/**
 * POST /api/kits/batch — start one job per uploaded role.
 *
 * The payload is the cases.json shape Appendix B defines, and the API parses it with the same
 * `parseCases` that `scripts/evaluate.ts` uses. One parser serves the upload and the batch
 * command, so the demo writes itself.
 *
 * Ids come back in input order so the progress screen can label its rows before any kit exists.
 */
export async function POST(request: Request) {
  return proxyJson("/kits/batch", { method: "POST", body: await forwardBody(request) });
}
