import { proxyJson } from "@/lib/api/upstream";

/**
 * `/api/sessions/:id` — one conversation in full.
 *
 * What a reload reads to put the transcript back: every ask in the words it was asked, in order,
 * with the run it started and the kit it produced.
 */
export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  return proxyJson(`/sessions/${encodeURIComponent(sessionId)}`);
}
