import { proxyJson } from "@/lib/api/upstream";

/**
 * `/api/jobs` — every run this user has started, finished or not.
 *
 * The history list was built from kits alone, and a kit does not exist until its job finishes.
 * Navigating away from the progress screen therefore lost the run: nothing in the sidebar, no
 * way back to it, and no sign it had ever been started. Jobs are listable so a row can exist
 * from the moment a run is accepted.
 */
export async function GET() {
  return proxyJson("/jobs");
}
