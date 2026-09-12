import type { KitSummary, SessionKitView, SessionSummary } from "@/lib/api/types";

/**
 * The history rail lists conversations.
 *
 * It listed kits first, and a kit does not exist until its job succeeds — so a run that failed
 * left nothing behind, and the trace you most wanted to read was gone the moment you reloaded.
 * The fix at the time was to list runs as well and merge the two lists in the browser, which
 * worked but left the rail rendering two different entity types side by side and re-sorting them
 * against each other on every render.
 *
 * Forking made that worse rather than better: one kit and its three rewrites are four rows that
 * are identical in every field the row shows.
 *
 * So the merge moved to the API, where both lists are already in hand, and what comes back is
 * one row per conversation with its kits nested under it. See `apps/api/src/sessions.ts` — a
 * session is a `GROUP BY`, not a collection.
 */

/** How many kits the user has, across every conversation — the count under the user chip. */
export function kitCount(sessions: readonly SessionSummary[]): number {
  return sessions.reduce((total, session) => total + session.kits.length, 0);
}

/**
 * Every kit, newest first, for the comparison view.
 *
 * Flattened back out on purpose: comparing is the one place where the conversation a kit came
 * from does not matter — you are holding two kits up against each other, and two revisions of
 * one kit is as legitimate a comparison as two different roles.
 */
export function kitsOf(sessions: readonly SessionSummary[]): KitSummary[] {
  return sessions
    .flatMap((session) => session.kits.map((kit) => ({ kit, sessionId: session.id })))
    .sort((a, b) => b.kit.created_at - a.kit.created_at)
    .map(({ kit, sessionId }) => ({
      id: kit.id,
      title: kit.title,
      company: kit.company,
      days: kit.days,
      createdAt: kit.created_at,
      sessionId,
      revision: kit.revision,
    }));
}

/** Which session holds a given kit, for a `?kit=` link written before sessions existed. */
export function sessionOfKit(sessions: readonly SessionSummary[], kitId: string): string | null {
  return sessions.find((session) => session.kits.some((kit) => kit.id === kitId))?.id ?? null;
}

/**
 * What a conversation's row says under its title.
 *
 * A number of kits when it has them, because that is the thing the row is offering to expand.
 * The state of the newest run when it has none — which is every conversation whose only attempt
 * failed, and those are the rows a user is most often looking for.
 */
export function sessionLabel(session: SessionSummary): string {
  if (session.running) return "Running";
  if (session.kits.length === 0) {
    if (session.status === "failed") return "Failed";
    if (session.status === "queued") return "Queued";
    return "No kit";
  }
  return session.kits.length === 1 ? "1 kit" : `${session.kits.length} kits`;
}

/**
 * What a nested kit row says.
 *
 * What the rewrite did, when a rewrite produced it. Otherwise the role itself — *not* a fixed
 * "Built from the posting", because a batch submission puts several originals in one
 * conversation and that phrase is true of every one of them. Under a session titled after the
 * first role, six rows all saying the same sentence is a list you cannot use, which is the
 * problem nesting was supposed to solve.
 */
export function kitRowLabel(kit: SessionKitView): string {
  if (kit.changed !== undefined) return kit.changed;
  const company = kit.company.trim();
  const title = kit.title.trim();
  if (company !== "" && title !== "") return `${company} — ${title}`;
  return company || title || "Built from the posting";
}
