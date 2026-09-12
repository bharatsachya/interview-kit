import { proxyJson } from "@/lib/api/upstream";

/**
 * `/api/sessions` — the history rail's list.
 *
 * One conversation per row, its kits nested under it, already sorted by newest activity. The
 * rail used to fetch `/kits` and `/jobs` and merge them in the browser; the merge still has to
 * happen, but it happens once on the API where both lists are already in hand.
 */
export async function GET() {
  return proxyJson("/sessions");
}
