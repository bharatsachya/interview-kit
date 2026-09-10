import { proxyJson } from "@/lib/api/upstream";

/**
 * GET /api/kits/:id — what the kit view and the builder read.
 *
 * The API returns the builder projection: active items only, provenance flags intact, schedule
 * repaired. Archived items never leave the API, so nothing downstream can render one by
 * accident — which is why this proxy does not reshape the body.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return proxyJson(`/kits/${encodeURIComponent(kitId)}`);
}
